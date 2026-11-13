// Example scripts for the Python module. Titles are translated via i18n keys.
export const EXAMPLES = [
  {
    key: 'ex.intro',
    code: `# Python + IfcOpenShell running in your browser.
#
#   model      the active model (ifcopenshell.file) - the one you last clicked in
#   models     all loaded models: {"file name": ifcopenshell.file}
#   selection  the selected elements (list of entities)
#   app        bridge to the viewer: app.update(model), app.add_model(f, "name.ifc"),
#              app.download(f_or_text, "name"), app.select(elements), app.merge(files)
#
# Run with Ctrl+Enter. print() output appears in the console to the right.
import ifcopenshell.util.element as element

print(model.schema, "-", len(model.by_type("IfcProduct")), "products")
for e in selection[:10]:
    print(e.is_a(), e.Name, element.get_psets(e).keys())
`,
  },
  {
    key: 'ex.countClasses',
    code: `from collections import Counter

counts = Counter(e.is_a() for e in model.by_type("IfcElement"))
for cls, n in counts.most_common():
    print(f"{cls:<30} {n:>6}")
`,
  },
  {
    key: 'ex.setPset',
    code: `# Adds/updates a property set on the selected elements and reloads the model.
import ifcopenshell.api

targets = selection or model.by_type("IfcWall")
for e in targets:
    pset = ifcopenshell.util.element.get_pset(e, "Vispecta_Review")
    if pset:
        pset = model.by_id(pset["id"])
    else:
        pset = ifcopenshell.api.run("pset.add_pset", model, product=e, name="Vispecta_Review")
    ifcopenshell.api.run("pset.edit_pset", model, pset=pset, properties={
        "Status": "Checked",
        "Checked": True,
    })

print("Updated", len(targets), "elements")
app.update(model)  # show the changes in the viewer
`,
  },
  {
    key: 'ex.missingProperty',
    code: `# Finds elements that are missing a property and selects them in the viewer.
import ifcopenshell.util.element as element

PSET, PROP = "Pset_WallCommon", "FireRating"

missing = []
for e in model.by_type("IfcWall"):
    value = element.get_pset(e, PSET, PROP)
    if value in (None, ""):
        missing.append(e)

print(len(missing), "walls without", f"{PSET}.{PROP}")
app.select(missing)
`,
  },
  {
    key: 'ex.renameStoreys',
    code: `# Renames all storeys using their elevation, e.g. "Level +3.00".
for storey in model.by_type("IfcBuildingStorey"):
    elev = storey.Elevation or 0.0
    old = storey.Name
    storey.Name = f"Level {elev:+.2f}"
    print(old, "->", storey.Name)

app.update(model)
`,
  },
  {
    key: 'ex.exportCsv',
    code: `# Exports name, class, storey and all properties of every element to CSV.
import csv, io
import ifcopenshell.util.element as element

rows, cols = [], ["GlobalId", "Class", "Name", "Storey"]
for e in model.by_type("IfcElement"):
    container = element.get_container(e)
    row = {"GlobalId": e.GlobalId, "Class": e.is_a(), "Name": e.Name,
           "Storey": container.Name if container else ""}
    for pset, props in element.get_psets(e).items():
        for k, v in props.items():
            if k == "id":
                continue
            col = f"{pset}.{k}"
            if col not in cols:
                cols.append(col)
            row[col] = v
    rows.append(row)

buf = io.StringIO()
w = csv.DictWriter(buf, fieldnames=cols, delimiter=";")
w.writeheader()
w.writerows(rows)
app.download(buf.getvalue(), "properties.csv")
print(len(rows), "rows exported")
`,
  },
  {
    key: 'ex.removeClass',
    code: `# Removes all elements of a class (here: IfcFurnishingElement) and opens the result as a new model.
import ifcopenshell.api

CLASS = "IfcFurnishingElement"
result = ifcopenshell.file.from_string(model.to_string())
elements = result.by_type(CLASS)
for e in elements:
    ifcopenshell.api.run("root.remove_product", result, product=e)
print("Removed", len(elements), CLASS)
app.add_model(result, f"without-{CLASS}.ifc")
`,
  },
  {
    key: 'ex.merge',
    code: `# Merges all loaded models into one new model.
merged = app.merge(models.values())
print("Merged", len(models), "models:", len(merged.by_type("IfcProduct")), "products")
app.add_model(merged, "merged.ifc")
app.download(merged, "merged.ifc")
`,
  },
];
