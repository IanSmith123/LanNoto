# Third-party notices

LanNoto uses third-party components without modifying their sources. Full copyright notices and license texts are distributed in [licenses/THIRD_PARTY.txt](licenses/THIRD_PARTY.txt). The table below is a brief inventory; it does not replace those texts.

| Component | License | Source |
| --- | --- | --- |
| Milkdown / Crepe / kit | MIT | https://github.com/Milkdown/milkdown |
| Yjs | MIT | https://github.com/yjs/yjs |
| y-protocols | MIT | https://github.com/yjs/y-protocols |
| ygo | MIT | https://github.com/reearth/ygo |
| coder/websocket | ISC | https://github.com/coder/websocket |
| gofrs/flock | BSD-3-Clause | https://github.com/gofrs/flock |
| natefinch/atomic (ReplaceFile) | MIT | https://github.com/natefinch/atomic |
| Go standard library, x/image, x/sys | BSD-3-Clause | https://go.dev/ |
| KaTeX font files | SIL Open Font License 1.1 | https://github.com/KaTeX/KaTeX |
| Vite | MIT | https://github.com/vitejs/vite |
| TypeScript | Apache-2.0 | https://github.com/microsoft/TypeScript |
| Playwright | Apache-2.0 | https://github.com/microsoft/playwright |

Frontend transitive components include ProseMirror, CodeMirror, Vue, KaTeX, DOMPurify and Markdown processing libraries. Exact dependencies are recorded in `web/package-lock.json`. Run `node scripts/notices.mjs` after installing locked dependencies to regenerate the notice bundle. It includes the complete production npm dependency closure, a conservative superset of bundled modules, the Go modules used by the service and Go standard library. Build/test-only tools listed above are not shipped in the service binary.

KaTeX font copyright and Reserved Font Names are read from the actual TTF metadata and retained separately from the KaTeX code license. The official OFL text is kept in `licenses/upstream/OFL-1.1.txt`. `remark-math` 6.0.0 omits its license file from its npm package, so its original license is retained from upstream commit `d5d0660b150810a535bbb07eac6cc96a4510aa24` in `licenses/upstream/remark-math-6.0.0.txt`. Missing license texts stop generation.

`node scripts/release.mjs` includes the notices in each platform archive. Pandoc is installed separately on the host and is not redistributed by these archives. The portable compiler used for race checks stays in ignored test artifacts and is not distributed.
