// netlify/functions/cdp-compliance.js
//
// CDP Compliance — RAW-DATA verified, read-only port of CdpComplianceController.
// Queries the Bonito Postgres READ REPLICA. Every statement is a SELECT.
// NEVER write here: the replica rejects writes (PG::ReadOnlySqlTransaction),
// which is the same bug that breaks _meeting.html.erb in Pulse.
//
// Ported checks (same verdict logic as the Rails controller):
//   1. rgm_notes_ok      CDD form filled OR DCM/RGM note text >= min_chars
//   2. rgm_recording_ok  SharePoint/Teams recording link in a DCM/RGM note
//   3. cdp_notes_ok      CDP note text >= min_chars
//   4. cdp_recording_ok  recording link in a CDP note
//   5. cdd_form_ok       DESIGN_DISCOVERY form has >=3 real answers
//   6. cdp_pdf_ok        a PDF attached in the CDP task's folder(s)
//   7. dm_review_ok      CDP_COMPLIANCE form filled with real DM scores  [NEW]
//
// Dropped vs Rails (needs binaries Netlify Functions can't run):
//   - BOQ / page-count OCR   -> was on-demand only, not in the verdict
// CDP PDF -> link to Pulse /drive (no S3 signing; simpler and never expires).

const { Pool } = require("pg");

// ---- config (mirrors the Ruby constants) --------------------------------
const CDP_TASK_CODE  = "prebook_design_presentation";
const RGM_TASK_CODE  = "prebook_requirements";
const GROSS_TASK_CODE = "token_advance";
const NET_TASK_CODE  = "design_fees";
const CDD_FORM_CODE  = "DESIGN_DISCOVERY";
const CDP_COMPLIANCE_FORM_CODE = "CDP_COMPLIANCE";
const DEFAULT_MIN_CHARS = 100;
const MAX_PROJECTS = 500;
const TURNKEY = 1; // Project.project_types[:turnkey]

// --- AI meeting insights (Pulse pipeline, live Aug 3 2026 onwards) ---
const CDP_MEETING_TYPE = 10;
const AI_CUTOFF = "2026-08-03";
const AI_READY = "insights_ready";

// --- DEM (design execution) milestones — Milestone-DM phase, scored separately ---
// DEM-1 = design_discussion2, DEM-2 = design_discussion3, DEM-3 = design_discussion4.
// "Done" = the task's close_date is set. No AI insights for DEM yet.
const DEM_TASKS = [
  ["dem1_ok", "design_discussion2", "DEM-1"],
  ["dem2_ok", "design_discussion3", "DEM-2"],
  ["dem3_ok", "design_discussion4", "DEM-3"],
];

// DM scoring item ids from the CDP_COMPLIANCE form (reference only + dm_review)
const DM_SCORE_ITEMS = {
  customer_requirement: "31585",
  theme: "31586",
  spatial_planning: "31587",
  render: "31588",
  quotation_variants: "31596",
};
const CDP_BUDGET_ITEM = "31591"; // CDP budget without discount (in lacs)

const PROJECT_STATUS_MAP = {
  1: "Active", 2: "Hold", 3: "Lost", 4: "Completed",
  5: "Pause", 6: "Future Possession", 7: "Blocked", 8: "Probable Active",
};

// Single pooled connection, reused across warm invocations.
let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.PGHOST || "bonitoapp-read-replica.cnxne33fjape.ap-south-1.rds.amazonaws.com",
      port: parseInt(process.env.PGPORT || "5432", 10),
      user: process.env.PGUSER || "postgres_read",
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE || "bonito",
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      // belt-and-braces: never let a write slip through
      options: "-c default_transaction_read_only=on",
    });
  }
  return pool;
}

// ---- helpers ------------------------------------------------------------
const stripHtml = (s) =>
  (s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

// A recording link is any Teams meetingrecap / SharePoint video / Stream URL.
const hasRecordingLink = (content) => {
  const c = content || "";
  return (
    /sharepoint\.com\/:v:/i.test(c) ||
    /sharepoint\.com\/[^"'\s]*\.(mp4|mov|webm)/i.test(c) ||
    /(web\.)?microsoftstream\.com/i.test(c) ||
    /teams\.(cloud\.microsoft|microsoft\.com)\/l\/meetingrecap/i.test(c) ||
    /teams\.microsoft\.com\/[^"'\s]*recording/i.test(c) ||
    /\|\s*meeting\s*\|\s*microsoft\s*teams/i.test(c)
  );
};
// Note tags are unreliable (a DCM recording can sit under a "cdp" tag), so we
// judge a recording by the MEETING NAMED in the recap text, not the note subject.
// DCM recap -> counts as the RGM/DCM recording; CDP recap -> the CDP recording.
const hasDcmRecording = (content) => {
  const c = content || "";
  if (!hasRecordingLink(c)) return false;
  return /design consultation meeting|\(dcm\)|\bdcm\b|\brgm\b/i.test(c);
};
const hasCdpRecording = (content) => {
  const c = content || "";
  if (!hasRecordingLink(c)) return false;
  return /celebrity design presentation|\(cdp\)/i.test(c);
};

const fmtL = (lacs) => {
  const n = parseFloat(lacs);
  if (!n || n <= 0) return null;
  return n === Math.trunc(n) ? `${Math.trunc(n)}L` : `${n.toFixed(1)}L`;
};

const parseRange = (from, to) => {
  const today = new Date();
  let f = from ? new Date(from) : new Date(today.getTime() - 7 * 864e5);
  let t = to ? new Date(to) : today;
  if (isNaN(f)) f = new Date(today.getTime() - 7 * 864e5);
  if (isNaN(t)) t = today;
  if (f > t) [f, t] = [t, f];
  const d = (x) => x.toISOString().slice(0, 10);
  return [d(f), d(t)];
};

// "filled" form = >=3 non-empty, non-"select" answers (mirrors cdd_form_filled?)
const formFilled = (data) =>
  Object.values(data || {}).filter(
    (v) => String(v).trim() && String(v).trim().toLowerCase() !== "select"
  ).length >= 3;

// dm_review passes when the CDP_COMPLIANCE form carries real DM scores.
const dmReviewPassed = (data) => {
  if (!data) return false;
  const filled = Object.values(DM_SCORE_ITEMS).filter((id) => {
    const v = String(data[id] ?? "").trim();
    return v && v.toLowerCase() !== "select" && v !== "0";
  }).length;
  return filled >= 3;
};

// ---- main handler -------------------------------------------------------
exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };

  const q = event.queryStringParameters || {};
  const [fromDate, toDate] = parseRange(q.from, q.to);
  const minChars = parseInt(q.min_chars || DEFAULT_MIN_CHARS, 10);
  const branch = (q.branch || "").trim();
  const pidParam = (q.pid || "").trim();

  const db = getPool();

  try {
    // 1) resolve the set of projects we care about ------------------------
    let projectIds = [];
    let pidSearch = false;

    if (pidParam) {
      // PID search ignores date/branch filters
      pidSearch = true;
      const pids = pidParam.split(",").map((s) => s.trim()).filter(Boolean)
        .map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
      const r = await db.query(
        `SELECT id FROM projects WHERE project_no = ANY($1::int[])`,
        [pids]
      );
      projectIds = r.rows.map((x) => x.id);
    } else {
      const params = [CDP_TASK_CODE, `${fromDate} 00:00:00`, `${toDate} 23:59:59.999`, TURNKEY];
      if (branch) params.push(branch);
      const sql = `
        SELECT DISTINCT p.id
        FROM projects p
        JOIN tasklists tl ON tl.listable_type = 'Project' AND tl.listable_id = p.id
        JOIN tasks t ON t.tasklist_id = tl.id
        ${branch ? "JOIN groups g ON g.id = p.group_id" : ""}
        WHERE t.code = $1
          AND t.close_date >= $2
          AND t.close_date <= $3
          AND p.project_type = $4
          ${branch ? "AND g.name = $5" : ""}`;
      const r = await db.query(sql, params);
      projectIds = r.rows.map((x) => x.id);
    }

    // available branches for the filter dropdown
    const branchesR = await db.query(
      `SELECT DISTINCT g.name FROM groups g
       JOIN projects p ON p.group_id = g.id
       JOIN tasklists tl ON tl.listable_id = p.id AND tl.listable_type = 'Project'
       JOIN tasks t ON t.tasklist_id = tl.id
       WHERE t.code = $1 AND t.close_date IS NOT NULL AND g.name IS NOT NULL
       ORDER BY g.name`,
      [CDP_TASK_CODE]
    );
    const availableBranches = branchesR.rows.map((r) => r.name);

    if (projectIds.length === 0) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({
        rows: [], summary: emptySummary(), available_branches: availableBranches,
        no_data: true, from: fromDate, to: toDate, min_chars: minChars }) };
    }
    if (!pidSearch && projectIds.length > MAX_PROJECTS) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({
        rows: [], summary: { ...emptySummary(), total_found: projectIds.length },
        available_branches: availableBranches, too_many: true,
        from: fromDate, to: toDate, min_chars: minChars }) };
    }

    // 2) bulk-load everything we need, keyed by project id ----------------
    const ids = projectIds;

    const [
      projMeta, notes, cddForms, cdpForms, pdfFlags, statuses, props, cdpDates, aiInsights, demStatus,
    ] = await Promise.all([
      projectMeta(db, ids),
      notesByProject(db, ids),
      formResponses(db, ids, CDD_FORM_CODE),
      formResponses(db, ids, CDP_COMPLIANCE_FORM_CODE),
      cdpPdfPresence(db, ids),
      projectStatuses(db, ids),
      propertyBudgets(db, ids),
      cdpCloseDates(db, ids),
      aiInsightsByProject(db, ids),
      demByProject(db, ids),
    ]);

    // 3) assemble rows ----------------------------------------------------
    const rows = ids.map((id) => {
      const meta = projMeta[id] || {};
      const nList = notes[id] || [];
      const rgm = nList.filter((n) => /^(DCM|RGM)/i.test(n.subject));
      const cdp = nList.filter((n) => /^CDP/i.test(n.subject));

      const cddEntry = cddForms[id];
      const cddData = cddEntry ? cddEntry.data : null;
      const cddFilled = cddData ? formFilled(cddData) : false;
      const rgmNotesContent = rgm.some((n) => n.text_len >= minChars);

      const cdpEntry = cdpForms[id];
      const cdpData = cdpEntry ? cdpEntry.data : null;

      // --- AI meeting insight (Pulse pipeline) ---
      const ai = aiInsights[id] || {};
      const cdpMeetingDate = ai.cdp_meeting_date || cdpDates[id] || "";
      const aiApplies = cdpMeetingDate && cdpMeetingDate.slice(0, 10) >= AI_CUTOFF;
      const aiCdpReady = !!ai.cdp_ready;

      const checks = {
        rgm_notes_ok:     cddFilled || rgmNotesContent,
        // Recording judged by the meeting named in the recap link (any note),
        // since note subject tags are unreliable (DCM recap can sit under "cdp").
        rgm_recording_ok: nList.some((n) => n.dcm_rec),
        // A ready AI insight proves the CDP meeting was recorded + transcribed,
        // so it satisfies both CDP notes and CDP recording.
        cdp_notes_ok:     aiCdpReady || cdp.some((n) => n.text_len >= minChars),
        cdp_recording_ok: aiCdpReady || nList.some((n) => n.cdp_rec),
        cdd_form_ok:      cddFilled,
        cdp_pdf_ok:       !!pdfFlags[id],
        dm_review_ok:     dmReviewPassed(cdpData),
      };
      // 8th check, only when the CDP meeting is in the AI era:
      if (aiApplies) checks.ai_cdp_ok = aiCdpReady;

      const dmScores = {};
      if (cdpData) for (const [k, itemId] of Object.entries(DM_SCORE_ITEMS)) dmScores[k] = String(cdpData[itemId] ?? "");

      let cdpBudget = null;
      if (cdpData) {
        const v = String(cdpData[CDP_BUDGET_ITEM] ?? "").trim();
        if (v && parseFloat(v) > 0) cdpBudget = `${v}L`;
      }

      // DEM milestones (separate phase, scored apart from CDP NET)
      const dem = demStatus[id] || {};
      const dem1 = !!dem.dem1_ok, dem2 = !!dem.dem2_ok, dem3 = !!dem.dem3_ok;
      const demPassed = [dem1, dem2, dem3].filter(Boolean).length;
      const demPct = Math.round((demPassed * 100) / 3);
      const demBand = demPct === 100 ? "green" : demPct >= 34 ? "amber" : "red";

      const row = {
        project_id: id,
        project_no: String(meta.project_no ?? ""),
        cx_name: meta.cx_name || "",
        branch: meta.branch || "",
        designer: meta.designer || "",
        design_manager: meta.design_manager || "",
        ms_designer: meta.ms_designer || "",
        ms_design_manager: meta.ms_design_manager || "",
        cdp_date: cdpDates[id] || "",
        project_status: statuses[id] || "Unknown",
        gross_budget: props[id] || "",
        cdp_budget: cdpBudget || "",
        cdp_pdf_ok: checks.cdp_pdf_ok,
        cdp_pdf_filename: pdfFlags[id]?.filename || null,
        cdd_rid: cddEntry ? cddEntry.rid : null,
        dmr_rid: cdpEntry ? cdpEntry.rid : null,
        dm_scores: dmScores,
        // DEM (separate score)
        dem1_ok: dem1, dem2_ok: dem2, dem3_ok: dem3,
        dem_dates: dem.dem_dates || {},
        dem_passed: demPassed, dem_pct: demPct, dem_band: demBand,
        // AI insight surface (read-only, the tech team's pipeline output)
        ai_applies: aiApplies,
        ai_cdp_ready: aiCdpReady,
        ai_summary: ai.summary || "",
        ai_sentiment: ai.sentiment || "",
        ai_meeting_date: cdpMeetingDate,
        ...checks,
      };
      computeOverall(row);
      return row;
    });

    // 4) designer / status filters (post-build, like the Ruby) -----------
    let out = rows;
    if (!pidSearch) {
      const designer = (q.designer || "").trim().toLowerCase();
      const status = (q.status || "").trim();
      if (designer) out = out.filter((r) => r.designer.toLowerCase().includes(designer));
      if (status) out = out.filter((r) => r.project_status === status);
    }

    const availableDesigners = [...new Set(rows.map((r) => r.designer).filter(Boolean))].sort();

    return { statusCode: 200, headers: cors, body: JSON.stringify({
      rows: out,
      summary: buildSummary(out),
      available_branches: availableBranches,
      available_designers: availableDesigners,
      available_statuses: Object.values(PROJECT_STATUS_MAP),
      from: fromDate, to: toDate, min_chars: minChars, pid_search: pidSearch,
    }) };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};

// ---- verdict + summary (ported) ----------------------------------------
const SCORE_CHECKS = [
  ["rgm_notes_ok", "RGM/DCM notes"],
  ["rgm_recording_ok", "RGM recording"],
  ["cdp_notes_ok", "CDP notes"],
  ["cdp_recording_ok", "CDP recording"],
  ["cdd_form_ok", "CDD form"],
  ["cdp_pdf_ok", "CDP presentation"],
  ["dm_review_ok", "DM review"],
];
const AI_CHECK = ["ai_cdp_ok", "AI insight (CDP)"];

function computeOverall(row) {
  // Always 7 checks. The AI insight is NOT scored separately - it already
  // satisfies cdp_notes_ok and cdp_recording_ok (an insight proves the CDP
  // meeting was recorded + transcribed). So AI is one WAY to pass CDP, not an
  // extra hurdle. AI CDP stays as a display-only column.
  const checks = SCORE_CHECKS;
  const passed = checks.filter(([k]) => row[k]).length;
  const total = checks.length;
  const pct = Math.round((passed * 100) / total);
  row.net_passed = passed;
  row.net_total = total;
  row.net_pct = pct;
  row.net_band = pct === 100 ? "green" : pct >= 67 ? "amber" : "red";
  row.net_reason = checks.filter(([k]) => !row[k]).map(([, l]) => l).join(", ");
}

function buildSummary(rows) {
  const total = rows.length;
  const compliant = rows.filter((r) => r.net_pct === 100).length;
  return {
    total,
    compliant,
    non_compliant: total - compliant,
    pct_compliant: total ? Math.round((compliant * 100) / total) : 0,
    avg_score: total ? Math.round(rows.reduce((s, r) => s + r.net_pct, 0) / total) : 0,
    pdf_uploaded: rows.filter((r) => r.cdp_pdf_ok).length,
    branches: new Set(rows.map((r) => r.branch).filter(Boolean)).size,
    total_found: total,
  };
}

const emptySummary = () => ({
  total: 0, compliant: 0, non_compliant: 0, pct_compliant: 0,
  avg_score: 0, pdf_uploaded: 0, branches: 0, total_found: 0,
});

// ---- data loaders (bulk, id-keyed) -------------------------------------
async function projectMeta(db, ids) {
  // users store name as fname + lname; project_users links to roles via role_id.
  // No `current` column here — `primary` marks the active assignment, with a
  // fallback to the most recent row by id when nothing is flagged primary.
  const uname = "TRIM(CONCAT(u.fname, ' ', u.lname))";
  const roleLookup = (roleCode) => `
     LEFT JOIN LATERAL (
       SELECT ${uname} AS nm
       FROM project_users pu
       JOIN users u ON u.id = pu.user_id
       JOIN roles ro ON ro.id = pu.role_id AND ro.code = '${roleCode}'
       WHERE pu.project_id = p.id
       ORDER BY pu.primary DESC, pu.id DESC
       LIMIT 1
     )`;
  const r = await db.query(
    `SELECT p.id, p.project_no, acc.name AS cx_name, g.name AS branch,
            dsg.nm AS designer, ndsg.nm AS net_designer,
            dm.nm AS design_manager, ndm.nm AS net_design_manager
     FROM projects p
     LEFT JOIN accounts acc ON acc.id = p.account_id
     LEFT JOIN groups g ON g.id = p.group_id
     ${roleLookup("designer")} dsg ON true
     ${roleLookup("net_designer")} ndsg ON true
     ${roleLookup("design_manager")} dm ON true
     ${roleLookup("net_design_manager")} ndm ON true
     WHERE p.id = ANY($1::bigint[])`,
    [ids]
  );
  const out = {};
  for (const x of r.rows) {
    out[x.id] = {
      project_no: x.project_no,
      cx_name: x.cx_name,
      branch: x.branch,
      designer: x.net_designer || x.designer || "",          // CDP-view designer
      // CDP-view DM: Net DM only. "Unassigned" when none (real signal, no fallback).
      design_manager: x.net_design_manager || "Unassigned",
      ms_designer: x.designer || "",                          // Milestone-view designer
      ms_design_manager: x.design_manager || "",              // Milestone-view DM
    };
  }
  return out;
}

async function notesByProject(db, ids) {
  const r = await db.query(
    `SELECT notable_id, subject, content FROM notes
     WHERE notable_type = 'Project' AND notable_id = ANY($1::bigint[])`,
    [ids]
  );
  const out = {};
  for (const n of r.rows) {
    (out[n.notable_id] ||= []).push({
      subject: n.subject || "",
      text_len: stripHtml(n.content).length,
      rec: hasRecordingLink(n.content),
      dcm_rec: hasDcmRecording(n.content),
      cdp_rec: hasCdpRecording(n.content),
    });
  }
  return out;
}

// latest response.data per project for a given form code
async function formResponses(db, ids, formCode) {
  const r = await db.query(
    `SELECT DISTINCT ON (sf.form_sendable_id) sf.form_sendable_id AS pid, resp.id AS rid, resp.data
     FROM form_wizard_sent_forms sf
     JOIN form_wizard_forms f ON f.id = sf.form_id
     JOIN form_wizard_responses resp ON resp.form_wizard_sent_form_id = sf.id
     WHERE f.code = $1
       AND sf.form_sendable_type = 'Project'
       AND sf.form_sendable_id = ANY($2::bigint[])
     ORDER BY sf.form_sendable_id, resp.created_at DESC`,
    [formCode, ids]
  );
  const out = {};
  for (const x of r.rows) {
    let data = {};
    try { data = typeof x.data === "string" ? JSON.parse(x.data) : x.data || {}; } catch { data = {}; }
    out[x.pid] = { data, rid: x.rid };
  }
  return out;
}

// PDF present in any folder owned by the project's CDP task
async function cdpPdfPresence(db, ids) {
  const r = await db.query(
    `SELECT DISTINCT ON (tl.listable_id) tl.listable_id AS pid, b.filename, b.key
     FROM tasks t
     JOIN tasklists tl ON tl.id = t.tasklist_id
       AND tl.listable_type = 'Project' AND tl.listable_id = ANY($1::bigint[])
     JOIN folders fo ON fo.owner_type = 'Task' AND fo.owner_id = t.id
     JOIN active_storage_attachments a ON a.record_type = 'Folder' AND a.record_id = fo.id
     JOIN active_storage_blobs b ON b.id = a.blob_id AND b.content_type = 'application/pdf'
     WHERE t.code = $2
     ORDER BY tl.listable_id, a.created_at DESC`,
    [ids, CDP_TASK_CODE]
  );
  const out = {};
  for (const x of r.rows) out[x.pid] = { filename: x.filename, key: x.key };
  return out;
}

async function projectStatuses(db, ids) {
  const r = await db.query(
    `SELECT DISTINCT ON (project_id) project_id, status FROM project_statuses
     WHERE project_id = ANY($1::bigint[]) AND current = true
     ORDER BY project_id, date DESC`,
    [ids]
  );
  const out = {};
  for (const x of r.rows) out[x.project_id] = PROJECT_STATUS_MAP[x.status] || `Status ${x.status}`;
  return out;
}

async function propertyBudgets(db, ids) {
  const r = await db.query(
    `SELECT p.id AS pid, pr.budget_from, pr.budget_to, pr.budget
     FROM projects p JOIN properties pr ON pr.id = p.property_id
     WHERE p.id = ANY($1::bigint[])`,
    [ids]
  );
  const out = {};
  for (const x of r.rows) {
    const bf = parseFloat(x.budget_from) || 0;
    const bt = parseFloat(x.budget_to) || 0;
    const b = parseFloat(x.budget) || 0;
    let g = null;
    if (bf > 0 && bt > 0 && bf !== bt) g = `${fmtL(bf)}-${fmtL(bt)}`;
    else if (bf > 0) g = fmtL(bf);
    else if (b > 0) g = fmtL(b);
    out[x.pid] = g;
  }
  return out;
}

async function cdpCloseDates(db, ids) {
  const r = await db.query(
    `SELECT tl.listable_id AS pid, t.close_date FROM tasks t
     JOIN tasklists tl ON tl.id = t.tasklist_id
       AND tl.listable_type = 'Project' AND tl.listable_id = ANY($1::bigint[])
     WHERE t.code = $2`,
    [ids, CDP_TASK_CODE]
  );
  const out = {};
  for (const x of r.rows) {
    if (x.close_date) {
      const d = new Date(x.close_date);
      out[x.pid] = d.toISOString().slice(0, 16).replace("T", " ");
    }
  }
  return out;
}

// DEM milestone completion: which of the three DEM agenda tasks are closed.
async function demByProject(db, ids) {
  const codes = DEM_TASKS.map(([, code]) => code);
  const r = await db.query(
    `SELECT tl.listable_id AS pid, t.code, t.close_date
     FROM tasks t
     JOIN tasklists tl ON tl.id = t.tasklist_id
       AND tl.listable_type = 'Project' AND tl.listable_id = ANY($1::bigint[])
     WHERE t.code = ANY($2::text[])`,
    [ids, codes]
  );
  const byPid = {};
  for (const x of r.rows) {
    (byPid[x.pid] = byPid[x.pid] || {})[x.code] = x.close_date;
  }
  const out = {};
  for (const pid of Object.keys(byPid)) {
    const closed = byPid[pid];
    const o = { dem_dates: {} };
    for (const [key, code, label] of DEM_TASKS) {
      const cd = closed[code];
      o[key] = !!cd;
      o.dem_dates[label] = cd ? new Date(cd).toISOString().slice(0, 10) : "";
    }
    out[pid] = o;
  }
  return out;
}
// meetings.meeting_type = 10, attached to the Project; latest ready insight wins.
// sentiment lives in insights_json->>'client_sentiment' (Positive/Mixed/Negative).
async function aiInsightsByProject(db, ids) {
  const r = await db.query(
    `SELECT DISTINCT ON (m.meetable_id)
            m.meetable_id AS pid,
            m.start_date  AS cdp_meeting_date,
            mi.status     AS insight_status,
            mi.insights_json->>'summary'          AS summary,
            mi.insights_json->>'client_sentiment' AS sentiment
     FROM meetings m
     LEFT JOIN meeting_insights mi ON mi.meeting_id = m.id
     WHERE m.meeting_type = $2
       AND m.meetable_type = 'Project'
       AND m.meetable_id = ANY($1::bigint[])
     ORDER BY m.meetable_id,
              (mi.status = '${AI_READY}') DESC NULLS LAST,
              m.start_date DESC`,
    [ids, CDP_MEETING_TYPE]
  );
  const out = {};
  for (const x of r.rows) {
    const ready = x.insight_status === AI_READY;
    out[x.pid] = {
      cdp_ready: ready,
      summary: ready ? (x.summary || "") : "",
      sentiment: ready ? normSentiment(x.sentiment) : "",
      cdp_meeting_date: x.cdp_meeting_date
        ? new Date(x.cdp_meeting_date).toISOString().slice(0, 16).replace("T", " ")
        : "",
    };
  }
  return out;
}

function normSentiment(s) {
  if (!s) return "";
  const v = String(s).toLowerCase();
  if (v.includes("posit")) return "Positive";
  if (v.includes("negat")) return "Negative";
  if (v.includes("mix") || v.includes("neutral")) return "Mixed";
  return String(s).slice(0, 12);
}
