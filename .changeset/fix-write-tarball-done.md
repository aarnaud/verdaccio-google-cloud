---
'verdaccio-google-cloud': patch
---

Fix publishes failing with `upload.done is not a function`: `writeTarball` now exposes `done()` and `abort()` synchronously instead of after the async existence check.
