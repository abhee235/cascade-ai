// SettingsPage.tsx — the real settings surface: connection status from the server's capabilities greeting,
// the RUNTIME the agent's commands execute in (ADR-081 §4), and appearance. Only live, truthful data.

import {
	Activity,
	Bot,
	Container,
	Moon,
	MonitorSmartphone,
	Paintbrush,
	Palette,
	Plug,
	Server,
	Sun,
	SunMoon,
	Terminal,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'

function Row({
	label,
	description,
	icon: Icon,
	children,
}: {
	label: string
	description?: string
	icon?: LucideIcon
	children: React.ReactNode
}) {
	return (
		<div className="flex items-center justify-between gap-4 text-sm">
			<div className="flex gap-2">
				{Icon && <Icon className="mr-1 mt-1 inline h-4 w-4 shrink-0 text-foreground" />}
				<div className="flex flex-col gap-0.5">
					<span className="text-foreground">{label}</span>
					{description && <span className="text-muted-foreground">{description}</span>}
				</div>
			</div>

			<span className="min-w-0 truncate text-right font-medium">{children}</span>
		</div>
	)
}

/**
 * Where the agent's commands run.
 *
 * ADR-081 §4 makes this a CHOICE rather than an inference from whether Docker happens to be running, so the
 * control has to be honest about three separate things: what the user picked, what is actually in effect,
 * and whether Docker could serve the pick at all. They diverge — selecting Docker while Docker Desktop is
 * closed falls back to host rather than leaving the app unusable, and showing only the setting would tell
 * someone they have isolation when they do not.
 */
function RuntimeSection() {
	const { serverInfo, send } = useStore()
	const runtime = serverInfo?.runtime
	const mode = runtime?.mode
	const pending = runtime ? runtime.requested !== runtime.mode : false

	const choose = (next: 'host' | 'docker') => {
		if (!runtime || runtime.forcedHost || next === runtime.requested) return
		send({ type: 'setRuntimeMode', mode: next })
	}

	return (
		<section className="mt-10">
			<div className="flex items-center gap-1.5 border-b border-border pb-2 text-sm font-semibold uppercase tracking-wide text-foreground">
				<MonitorSmartphone className="h-4 w-4" /> Runtime
			</div>
			<div className="mt-2 space-y-3">
				<Row
					label="Commands run in"
					icon={Terminal}
					description="Where the agent executes shell commands"
				>
					{!runtime ? (
						'—'
					) : (
						<span className="inline-flex items-center gap-2">
							{mode === 'docker' ? (
								<span className="inline-flex items-center gap-1">
									<Container className="h-3.5 w-3.5" /> Docker
								</span>
							) : (
								<span>This machine</span>
							)}
						</span>
					)}
				</Row>
				<div className="flex flex-wrap items-center gap-2">
					<Button variant={runtime?.requested === 'host' ? 'default' : 'secondary'} size="sm" disabled={!runtime || runtime.forcedHost} onClick={() => choose('host')}>
						Host
					</Button>
					<Button variant={runtime?.requested === 'docker' ? 'default' : 'secondary'} size="sm" disabled={!runtime || runtime.forcedHost} onClick={() => choose('docker')} className="gap-1.5">
						<Container className="h-3.5 w-3.5" /> Docker
					</Button>
				</div>
			</div>

			{/* The trade, stated where the choice is made rather than buried in docs — ADR-081 §4 asks for it to
			    be deliberate and never an accident. */}
			<p className="mt-2 text-xs text-muted-foreground">
				{mode === 'docker'
					? 'Each project runs in its own container. Commands cannot reach the rest of your machine, and dependencies stay inside the container.'
					: 'Commands run directly on this machine, like an editor’s task runner. Nothing to install, but no isolation — the agent can run build scripts and install packages here.'}
			</p>
			{pending && (
				<p className="mt-1 text-xs text-yellow-500">
					Docker is selected but not responding, so commands are running on this machine. Start Docker Desktop and choose Docker again.
				</p>
			)}
			{runtime?.forcedHost && <p className="mt-1 text-xs text-muted-foreground">Pinned to host by CASCADE_SANDBOX=off.</p>}
		</section>
	)
}

export function SettingsPage() {
	const { connected, serverInfo, theme, toggleTheme, setCustomizeOpen } = useStore()

	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto max-w-3xl px-6 py-8">
				<h1 className="text-2xl font-semibold">Settings</h1>

				<section className="mt-8">
					<div className="flex items-center gap-1.5 border-b border-border pb-2 text-sm font-semibold uppercase tracking-wide text-foreground">
						<Plug className="h-4 w-4" /> Connection
					</div>
					<div className="mt-2 space-y-3">
						<Row label="Server" icon={Server} description="WebSocket address of the backend server">
							<span className="font-mono text-xs">ws://{location.hostname}:4319</span>
						</Row>
						<Row label="Status" icon={Activity} description="Live connection to the backend">
							<span className={connected ? 'text-emerald-500' : 'text-yellow-500'}>{connected ? 'Connected' : 'Connecting…'}</span>
						</Row>
						<Row label="Model" icon={Bot} description="Model currently serving this session">
							{serverInfo?.model ?? '—'}
						</Row>
					</div>
				</section>

				<RuntimeSection />

				<section className="mt-10">
					<div className="flex items-center gap-1.5 border-b border-border pb-2 text-sm font-semibold uppercase tracking-wide text-foreground">
						<Palette className="h-4 w-4" /> Appearance
					</div>
					<div className="mt-2 space-y-3">
						<Row label="Theme" icon={SunMoon} description="Light or dark interface">
							<Button variant="secondary" size="sm" onClick={toggleTheme} className="gap-1.5">
								{theme === 'dark' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
								{theme === 'dark' ? 'Dark' : 'Light'} — switch
							</Button>
						</Row>
						<Row label="Accent color" icon={Paintbrush} description="Highlight color used across the UI">
							<Button variant="secondary" size="sm" onClick={() => setCustomizeOpen(true)}>
								Customize…
							</Button>
						</Row>
					</div>
				</section>

				<p className="mt-10 text-xs text-muted-foreground">
					Switch models from the picker in a project; configure tool servers in the <strong>MCP</strong> panel. The default model is set with{' '}
					<code className="rounded bg-muted px-1 py-0.5">CASCADE_MODEL</code> when starting the server.
				</p>
			</div>
		</div>
	)
}
