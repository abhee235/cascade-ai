// monaco.ts — self-host the Monaco editor (VS Code's editor) instead of @monaco-editor/react's default CDN
// loader. This makes the Code pane work offline / under CSP / inside the sandboxed preview context, with no
// runtime jsdelivr dependency. Vite bundles the language workers via `?worker`. Import this once (main.tsx).

import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

// ADR-092: the defaults (JSX off, no `@/` alias, no node_modules in the browser) underlined EVERY import and JSX
// line in red, even in projects whose build is green. Match the templates' options, and check SYNTAX only: the
// editor cannot load the project's dependency types, so its type errors would be wrong guesses. Real type errors
// come from `npm run build`, where they are true.
const compilerOptions = {
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
  jsx: monaco.typescript.JsxEmit.ReactJSX,
  allowJs: true,
  allowNonTsExtensions: true,
  esModuleInterop: true,
  isolatedModules: true,
  baseUrl: '.',
  paths: { '@/*': ['src/*'] },
}
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setCompilerOptions(compilerOptions)
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
}

loader.config({ monaco })
