# Codebase size

Snapshot of tracked application source on 2026-10-13, at commit `f0464211`.
The backend is `src/`; the frontend is `dashboard/src/`, matching the ownership
boundary in [Architecture](architecture.md).

| Area | Files | Source lines | Nonblank lines |
| --- | ---: | ---: | ---: |
| Backend | 467 | 109,388 | 103,454 |
| Frontend | 144 | 35,881 | 34,075 |
| **Total** | **611** | **145,269** | **137,529** |

Source lines count physical lines in tracked TypeScript, TSX, JavaScript, JSX,
CSS, SCSS, HTML, and SQL files under those directories. Nonblank lines omit
empty or whitespace-only lines but still include comments. Tests, generated
assets, dependencies, scripts, migrations outside `src/`, and documentation are
not included. These are repository-size estimates, not language-aware logical
LOC; rerun the count after source changes for an updated snapshot.
