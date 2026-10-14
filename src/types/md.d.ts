// `import prompt from '../prompts/distill.md' with { type: 'text' }`
//
// bun build 会把 .md 内容**内联**进单文件产物（已实测），所以提示词既能保持
// 干净的 .md 形态、用编辑器正常高亮，又不破坏「dist/coach.mjs 是单文件」这条
// 部署约束。运行时不会去读磁盘上的 .md。
declare module '*.md' {
  const text: string
  export default text
}
