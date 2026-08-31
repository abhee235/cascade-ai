// LoginView — the auth wall's face (round 9). AuthCard block, the API's own error sentence on failure.

import { useState } from 'react'
import { PenTool } from 'lucide-react'
import { AuthCard } from '@/components/blocks/AuthCard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, ApiError } from '@/lib/api'

export function LoginView({ onSignedIn }: { onSignedIn: (email: string) => void }) {
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const u = await api<{ email: string }>('POST', '/api/auth/login', { email, password })
			onSignedIn(u.email)
		} catch (err) {
			setError(err instanceof ApiError ? err.message : 'could not reach the server')
		} finally {
			setBusy(false)
		}
	}

	return (
		<AuthCard
			brand={
				<span className="flex items-center gap-2">
					<PenTool className="size-4 text-primary" /> Studio Manager
				</span>
			}
			title="Welcome back"
			subtitle="Sign in to manage clients and invoices."
			error={error}
		>
			<form onSubmit={submit} className="flex flex-col gap-4">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="email">Email</Label>
					<Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@studio.local" />
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="password">Password</Label>
					<Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
				</div>
				<Button type="submit" disabled={busy}>
					Sign in
				</Button>
			</form>
		</AuthCard>
	)
}
