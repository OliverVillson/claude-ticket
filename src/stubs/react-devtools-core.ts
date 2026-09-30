// Ink imports `react-devtools-core` only when DEV=true. It is an optional peer dependency
// that Bun cannot resolve when compiling a single binary, so it is aliased to this stub
// (see `paths` in tsconfig.json). Nothing here is used at runtime.
export default {
  initialize() {},
  connectToDevTools() {},
};
