// lib/api.ts — the typed API client. Relative '/api/...' URLs only (the dev proxy owns the port); the
// sid session cookie rides automatically (same-origin). Every non-2xx becomes an ApiError carrying the
// server's { error } sentence, so views surface the API's own words instead of inventing their own.

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
		this.name = 'ApiError'
	}
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method,
		headers: body === undefined ? undefined : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	if (res.status === 204) return undefined as T
	const text = await res.text()
	let json: unknown
	try {
		json = JSON.parse(text)
	} catch {
		json = undefined
	}
	if (!res.ok) throw new ApiError(res.status, (json as { error?: string })?.error ?? `request failed (${res.status})`)
	return json as T
}
