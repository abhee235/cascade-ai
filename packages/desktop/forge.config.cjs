// forge.config.cjs — how Cascade becomes an installable app (ADR-081 §7).
//
// CJS because Forge loads this config with `require`. It is the only CJS file in the package.
//
// The packaged layout, and why:
//   resources/server.mjs    the bundled server — imported by main, never spawned
//   resources/web/          the built UI, served over HTTP by that server
//   resources/resources/    skills, agents, templates (see server/src/resources.ts)
//
// Everything above sits OUTSIDE the asar archive. `node:sqlite` opens a real file, and an asar is a
// virtual filesystem that only Node's patched `fs` understands — a database inside it would be read-only
// at best. This is the same class of problem better-sqlite3 would have caused, which is exactly why the
// storage design chose a driver with no native module to unpack (ADR-081 §1).

const { existsSync } = require('node:fs')
const { join } = require('node:path')

const DIST = join(__dirname, 'dist')

/** Fail LOUDLY rather than shipping an app whose UI or server is simply absent. Packaging is a step people
 *  run rarely and under pressure; a missing bundle discovered by a user at launch is far more expensive
 *  than a failed build here. */
function assertBuilt() {
  for (const required of ['server.mjs', 'main.cjs', join('web', 'index.html'), join('resources', 'skills'), join('node_modules', 'playwright-core')]) {
    if (!existsSync(join(DIST, required))) {
      throw new Error(`packages/desktop/dist/${required} is missing — run "npm run build -w @cascade/desktop" before packaging.`)
    }
  }
}

module.exports = {
  packagerConfig: {
    name: 'Cascade',
    executableName: process.platform === 'win32' ? 'Cascade' : 'cascade',
    asar: true,
    /**
     * What NOT to put inside the asar.
     *
     * By default the packager copies the whole package directory in, which here means the browser and the
     * built web bundle land TWICE — once inside the archive and once beside it as extraResource. Measured:
     * a 596MB app.asar and a 1.3GB app, roughly double what it should be.
     *
     * Only `dist/main.cjs`, `package.json` and `node_modules` belong in the archive; everything the server
     * reads at runtime must stay outside it, because an asar is a virtual filesystem.
     */
    ignore: [
      /^\/browsers($|\/)/, // shipped via extraResource
      /^\/out($|\/)/, // previous packaging output
      /^\/src($|\/)/, // TypeScript sources; only the bundle ships
      /^\/build\.mts$/,
      /^\/forge\.config\.cjs$/,
      /^\/tsconfig\.json$/,
      /^\/dist\/(web|browsers|resources|node_modules)($|\/)/, // all extraResource
      /^\/dist\/server\.mjs/, // extraResource (and its .map)
    ],
    // Copied verbatim into the app's `resources/` directory, beside (not inside) the asar.
    extraResource: [join(DIST, 'server.mjs'), join(DIST, 'server.mjs.map'), join(DIST, 'web'), join(DIST, 'resources'), join(DIST, 'node_modules'), ...(existsSync(join(DIST, 'browsers')) ? [join(DIST, 'browsers')] : [])],
    appBundleId: 'ai.cascade.desktop',
    appCategoryType: 'public.app-category.developer-tools',
    // WINDOWS SIGNING. Unsigned builds still work — they just greet the user with SmartScreen — so this is
    // opt-in via environment rather than a hard requirement that would block anyone from producing a build.
    // Certificates never live in the repo: CI provides them, and a local build without them is expected.
    ...(process.env.WINDOWS_CERT_FILE
      ? {
          windowsSign: {
            certificateFile: process.env.WINDOWS_CERT_FILE,
            certificatePassword: process.env.WINDOWS_CERT_PASSWORD,
            // Timestamping is what keeps the signature valid AFTER the certificate expires. Without it every
            // release silently stops validating on the cert's expiry date.
            timestampServer: 'http://timestamp.digicert.com',
          },
        }
      : {}),
    // macOS: notarization needs an Apple Developer account. Same opt-in shape.
    ...(process.env.APPLE_ID
      ? {
          osxSign: {},
          osxNotarize: {
            appleId: process.env.APPLE_ID,
            appleIdPassword: process.env.APPLE_ID_PASSWORD,
            teamId: process.env.APPLE_TEAM_ID,
          },
        }
      : {}),
  },

  rebuildConfig: {},

  makers: [
    {
      // Windows: Squirrel produces Setup.exe plus the RELEASES/nupkg feed that auto-update reads.
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'Cascade',
        setupExe: 'CascadeSetup.exe',
        ...(process.env.WINDOWS_CERT_FILE ? { certificateFile: process.env.WINDOWS_CERT_FILE, certificatePassword: process.env.WINDOWS_CERT_PASSWORD } : {}),
      },
    },
    {
      // macOS: a zip, which is what update-electron-app's feed serves. A .dmg is prettier for a first
      // install but cannot be an update artifact, so the zip is the one that must exist.
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
  ],

  plugins: [
    // Moves any native module out of the asar. We ship none today — that is the point of node:sqlite — but
    // one arriving via a transitive dependency would otherwise fail at runtime in the packaged app only.
    { name: '@electron-forge/plugin-auto-unpack-natives', config: {} },
  ],

  hooks: {
    generateAssets: async () => assertBuilt(),
  },
}
