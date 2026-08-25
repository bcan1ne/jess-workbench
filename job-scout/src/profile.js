/**
 * The candidate profile and the JSON contract, shared by both paths.
 *
 * The wording is ported verbatim from runRefresh() in the Apps Script version
 * and is tuned. Change it on purpose or not at all.
 */

var CANDIDATE =
  'Client success and implementation professional in digital health. Background spans ' +
  'telehealth client implementation and account management, virtual maternity and doula program client ' +
  'success, corporate workplace wellbeing for self-insured employers, public health outreach and ' +
  'lactation consulting, and adjunct health science instruction. MBA plus MS in Entrepreneurial ' +
  'Nutrition, BS in Nutrition. Strengths: client relationship management, program implementation and ' +
  'launch readiness, cross-functional coordination, webinar and public speaking, translating nutrition ' +
  'science for lay audiences. Tools: Salesforce, Metabase, Box, Microsoft Office, Google Workspace, ' +
  'Zoom, LMS platforms.';

var CONTRACT =
  '{"fit": <1-10 integer>, "company": "", "title": "", "url": "", "salary": "", ' +
  '"salaryMin": <number or null>, "setup": "Remote|Hybrid|On-site", "location": "", ' +
  '"lat": <number or null>, "lon": <number or null>, "industry": "", "why": "", ' +
  '"watchOuts": "", "posted": ""}';

module.exports = { CANDIDATE: CANDIDATE, CONTRACT: CONTRACT };
