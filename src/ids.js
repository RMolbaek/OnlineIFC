// IDS (Information Delivery Specification) checking with IfcOpenShell's ifctester, run in the
// Python worker. Results are listed per specification; failing elements can be selected,
// coloured and exported.
import { t, fmtNum } from './i18n.js';
import { getPythonConfig } from './config.js';

export const IDS_COLORS = { pass: 0x2fb344, fail: 0xe03131 };
/** Colour-blind friendly (Okabe-Ito): blue = passes, vermilion = fails. */
export function setIdsColors(cvd) { Object.assign(IDS_COLORS, cvd ? { pass: 0x0072b2, fail: 0xd55e00 } : { pass: 0x2fb344, fail: 0xe03131 }); }

/** Example IDS files shipped with the app (public/examples/ids). */
export const IDS_EXAMPLES = [
  { file: '01-basic-information.ids', key: 'basic' },
  { file: '02-wall-and-slab-properties.ids', key: 'props' },
  { file: '03-materials-and-classification.ids', key: 'mat' },
  { file: '04-rail-infrastructure.ids', key: 'rail' },
];

/** Python code that validates the model with the given key against /tmp/check.ids. */
function idsCode(key) {
  const wheels = JSON.stringify(getPythonConfig().idsWheels || []);
  return `
import json, importlib.util
if importlib.util.find_spec("ifctester") is None:
    import micropip
    print("Installing ifctester…")
    await micropip.install(${wheels}, deps=False)
import ifctester, ifctester.ids, ifctester.reporter

_specs = ifctester.ids.open("/tmp/check.ids")
_specs.validate(_files[${JSON.stringify(String(key))}])
_data = ifctester.reporter.Json(_specs).report()

def _ent(e):
    return {"id": int(e.get("id") or 0), "gid": e.get("global_id"), "name": e.get("name"), "cls": e.get("class"), "reason": e.get("reason")}

_out = {"title": _data.get("title"), "status": bool(_data.get("status")), "specs": []}
for _s in _data["specifications"]:
    _failed = {}
    _reqs = []
    for _r in _s.get("requirements") or []:
        _reqs.append({"description": _r.get("description"), "status": bool(_r.get("status")), "fail": _r.get("total_fail", 0)})
        for _e in _r.get("failed_entities") or []:
            _x = _ent(_e)
            if _x["id"] in _failed:
                _failed[_x["id"]]["reasons"].append(_x["reason"])
            else:
                _x["reasons"] = [_x.pop("reason")]
                _failed[_x["id"]] = _x
    _applicable = []
    for _e in _s.get("applicable_entities") or []:
        _el = _e.get("element") if isinstance(_e, dict) else _e
        try:
            _applicable.append(int(_el.id()))
        except Exception:
            pass
    _out["specs"].append({
        "name": _s.get("name"), "description": _s.get("description"), "instructions": _s.get("instructions"),
        "status": bool(_s.get("status")), "skipped": bool(_s.get("is_skipped")),
        "applicable": _s.get("total_applicable", 0), "pass": _s.get("total_applicable_pass", 0), "fail": _s.get("total_applicable_fail", 0),
        "cardinality": _s.get("cardinality"), "requirements": _reqs, "failed": list(_failed.values()), "applicableIds": _applicable,
    })
print(f"IDS: {sum(1 for s in _out['specs'] if s['status'])} / {len(_out['specs'])} specifications passed")
app._result = json.dumps(_out)
del _specs, _data
`;
}

/**
 * Runs an IDS check for the given models. Returns [{model, report}] or null.
 * python: the PythonPanel (its worker runs the check).
 */
export async function runIdsCheck(python, models, idsText, idsName) {
  const results = [];
  for (const m of models) {
    const res = await python.runCodeResult(idsCode(m.uid), {
      title: t('ids.running', { name: m.name, ids: idsName }),
      files: [{ path: '/tmp/check.ids', text: idsText }],
    });
    if (!res) return null;
    results.push({ model: m, report: JSON.parse(res.result) });
  }
  return results;
}

/** Colours passing elements green and failing elements red for one specification (or all). */
export function colorIdsResult(entry, specIndex = null) {
  const { model, report } = entry;
  const colors = new Map();
  const specs = specIndex === null ? report.specs : [report.specs[specIndex]];
  for (const s of specs) {
    const failed = new Set(s.failed.map((f) => f.id));
    for (const id of s.applicableIds) if (!failed.has(id) && !colors.has(id)) colors.set(id, IDS_COLORS.pass);
  }
  for (const s of specs) for (const f of s.failed) colors.set(f.id, IDS_COLORS.fail);
  model.setElementColors(colors);
}

/** CSV with one row per failing element and requirement. */
export function idsCsv(results) {
  const rows = [[t('csv.model'), t('ids.spec'), t('ids.statusCol'), 'GlobalId', t('csv.class'), t('csv.name'), t('ids.reason')]];
  for (const { model, report } of results) {
    for (const s of report.specs) {
      if (!s.failed.length) rows.push([model.name, s.name, s.status ? t('ids.pass') : t('ids.fail'), '', '', '', '']);
      for (const f of s.failed) rows.push([model.name, s.name, t('ids.fail'), f.gid, f.cls, f.name, f.reasons.join(' | ')]);
    }
  }
  const esc = (v) => { const s = String(v ?? ''); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n');
}

export function specSummary(s) {
  if (s.skipped) return t('ids.skipped');
  // "prohibited": the applicable elements must not exist; "required": at least one must exist
  if (s.cardinality === 'prohibited') return s.applicable ? t('ids.prohibitedFound', { n: fmtNum(s.applicable) }) : t('ids.prohibitedNone');
  if (!s.applicable) return s.cardinality === 'required' ? t('ids.requiredNone') : t('ids.noneApplicable');
  return t('ids.specCounts', { pass: fmtNum(s.pass), fail: fmtNum(s.fail), total: fmtNum(s.applicable) });
}
