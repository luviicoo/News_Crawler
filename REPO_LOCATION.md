# News Crawler repository

Repository: https://github.com/luviicoo/News_Crawler

This is a standalone Node.js project. The repository root is the directory
containing `package.json`, `src/`, and `test/`. Develop and run Git commands
in this checkout. The checkout can live in any directory.

Install dependencies with `npm.cmd ci`, install Chromium with
`npx.cmd playwright install chromium`, and run `npm.cmd start` from the root.
See `README.md` for configuration, date ranges, and headless mode.

Both CLI entry points load `.env` from this repository root. Browser session
state is stored in `.google-state.json` here. Crawler output defaults to
`output/` here; relative `OUTPUT_DIR` values resolve from this root.

For `capture:pr-images`, the input JSON path and each item's relative
`screenshotDir` resolve from the command's working directory. Run the command
from the repository root or provide absolute paths.

Project output in `output/` and run logs in `logs/` are tracked in Git.
Local credentials, browser state, dependencies, and Git history backups
are excluded from Git by `.gitignore`.
