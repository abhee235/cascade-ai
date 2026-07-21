// fileGlyph.tsx — VS Code Material Icon Theme file icons, shared by the file tree, editor tabs, breadcrumb,
// and search results so a given file looks the SAME everywhere. `getIcon(filename)` (material-file-icons,
// the packaged Material Icon Theme) returns the exact multicolor SVG VS Code shows, auto-detecting by
// extension AND special filenames (package.json → npm, .gitignore → git, tsconfig.json → ts-config,
// vite.config.ts → vite, schema.prisma → prisma, …). Zero-dependency; the SVGs are inline strings.

import { getIcon } from 'material-file-icons'
import { cn } from '@/lib/utils'

export function FileGlyph({ path, className }: { path: string; className?: string }) {
  const { svg } = getIcon(path.split('/').pop() ?? path)
  // The library's SVGs carry their own multicolor fills; size them by making the inner <svg> fill the span
  // (CSS h-full/w-full overrides the SVG's intrinsic width/height). Trusted package content → safe HTML.
  return <span className={cn('inline-block shrink-0 [&>svg]:h-full [&>svg]:w-full', className)} dangerouslySetInnerHTML={{ __html: svg }} />
}
