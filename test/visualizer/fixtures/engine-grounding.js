// status.grounding exactly as the real engine wrote it for three finished runs (2026-11-10): integers where the
// section 24 example has floats, `by: "none"`, and a review criterion `unclear` with an empty `checks` list.
export const REAL_GROUNDING = [
  '{"mode":"enforce","answer":1,"trajectory":0.8333,"unadjusted":0.9167,"violation_rate":0.25,"adjusted":0.5156,"tier":"major","outputs":4,"violations":{"unseen_target":1},"criteria":[{"id":"sum","verified_by":"checks","state":"demonstrated","by":"baseline","checks":["test"]}],"probe":{"status":"not_needed"}}',
  '{"mode":"enforce","answer":1,"trajectory":0.3333,"unadjusted":0.6667,"violation_rate":0.25,"adjusted":0.375,"tier":"major","outputs":4,"violations":{"unseen_target":1},"criteria":[{"id":"sum","verified_by":"checks","state":"met_not_demonstrated","by":"none","checks":["test"]}],"probe":{"status":"not_needed"}}',
  '{"mode":"enforce","answer":1.0,"trajectory":1.0,"unadjusted":1.0,"violation_rate":0.2,"adjusted":0.64,"tier":"major","outputs":5,"violations":{"unsupported_assessment":1},"criteria":[{"id":"sum","verified_by":"review","state":"unclear","by":"review","checks":[]}],"probe":{"status":"not_needed"}}',
].map((s) => JSON.parse(s));

// status.grounding of the real `evidence` demo (run evidence09, 2026-11-10): succeeded, both ungrounded outputs
// rejected and repaired, tier still `failing` because five outputs make two rejections a 40% violation rate.
export const REAL_EVIDENCE_DEMO = JSON.parse('{"mode":"enforce","answer":1,"trajectory":0.3889,"unadjusted":0.6944,"violation_rate":0.4,"adjusted":0.25,"tier":"failing","outputs":5,"violations":{"false_absence":1,"unseen_target":1},"criteria":[{"id":"sum","verified_by":"checks","state":"demonstrated","by":"baseline","checks":["unit"]},{"id":"syntax","verified_by":"checks","state":"met_not_demonstrated","by":"none","checks":["syntax"]}],"probe":{"status":"not_needed"}}');

// the absence_refuted event of the same run, exactly as events.jsonl has it
export const REAL_ABSENCE_REFUTED = JSON.parse('{"seq":36,"ts":"2026-11-10T08:41:02.771728+00:00","run_id":"evidence09","type":"absence_refuted","node":null,"data":{"kind":"missing_symbol","subject":"add","hits":[{"path":"calculator.py","line":1}]}}');
