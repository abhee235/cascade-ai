// design-sync bundle entry (passed as --entry).
//
// @cascade/web is an app, not a component library, so there is no published
// dist entry to bundle. This focused entry re-exports ONLY the 14 shadcn UI
// primitives (src/components/ui/*) — deliberately NOT the app-composition
// components (builder/, chat/, layout/) that depend on zustand/Monaco/xterm.
// `export *` carries every sub-part (DialogContent, SelectItem, …) into
// window.CascadeWebUI so the design agent can compose full compounds.
export * from '../src/components/ui/button';
export * from '../src/components/ui/command';
export * from '../src/components/ui/dialog';
export * from '../src/components/ui/dropdown-menu';
export * from '../src/components/ui/input';
export * from '../src/components/ui/scroll-area';
export * from '../src/components/ui/select';
export * from '../src/components/ui/separator';
export * from '../src/components/ui/sheet';
export * from '../src/components/ui/sidebar';
export * from '../src/components/ui/skeleton';
export * from '../src/components/ui/tabs';
export * from '../src/components/ui/textarea';
export * from '../src/components/ui/tooltip';
