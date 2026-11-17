# ECG Records — website

The website of the ECG device's online records. It has no server of its own: it reads the private records
repository (`<organisation>/ecg-records`) straight from the GitHub API with the viewer's access key, which stays in
the viewer's browser. The device fills the records with SHARE → UPLOAD; names and notes edited here reach the device
at its next UPLOAD.

Published by `tools\set_cloud.bat` on the laptop (it copies these files here). Nothing to build.
