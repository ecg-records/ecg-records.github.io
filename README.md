# ECG Records — website

The website of the ECG device's online records, and the same app the device serves as its PHONE PAGE. It has no
server of its own: it reads and writes the private records repository (`<organisation>/ecg-records`) through the
GitHub API with the viewer's access key, which stays in the viewer's browser.

- `index.json` — the list (written by the device at each UPLOAD)
- `meta.json` — each recording's details: name or code, age, sex, note, reviewed, in the bin (per field: when, who, where)
- `changes.jsonl` — every change, one line each, only ever added to
- `recordings/<folder>/` — the device's files, never changed

Edits made here are saved online at once; the device takes them at its next UPLOAD (or within minutes while its
phone page is on). Per field, the newer edit wins wherever it was made. Deleting moves a recording to the bin
everywhere; nothing is erased, and it can be restored.

The device republishes these files when they differ from its own copy (`uno_q_app/website/`); `tools\set_cloud.bat`
does the same from the laptop. Nothing to build.
