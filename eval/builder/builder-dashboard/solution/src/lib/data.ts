export type RunStatus = 'delivered' | 'delayed' | 'cancelled'

export interface Run {
	id: string
	route: string
	driver: string
	status: RunStatus
	date: string
	cost: number
}

export const RUNS: Run[] = [
	{ id: 'r01', route: 'Sheffield → Leeds', driver: 'Priya Raman', status: 'delivered', date: '2026-03-02', cost: 184 },
	{ id: 'r02', route: 'Leeds → York', driver: 'Sam Okafor', status: 'delivered', date: '2026-03-02', cost: 96 },
	{ id: 'r03', route: 'Manchester → Sheffield', driver: 'Lena Fischer', status: 'delayed', date: '2026-03-03', cost: 212 },
	{ id: 'r04', route: 'York → Hull', driver: 'Marco Salas', status: 'delivered', date: '2026-03-03', cost: 141 },
	{ id: 'r05', route: 'Hull → Grimsby', driver: 'Priya Raman', status: 'delivered', date: '2026-03-04', cost: 78 },
	{ id: 'r06', route: 'Leeds → Bradford', driver: 'Sam Okafor', status: 'cancelled', date: '2026-03-04', cost: 0 },
	{ id: 'r07', route: 'Sheffield → Nottingham', driver: 'Aisha Bello', status: 'delivered', date: '2026-03-05', cost: 165 },
	{ id: 'r08', route: 'Nottingham → Derby', driver: 'Marco Salas', status: 'delayed', date: '2026-03-05', cost: 88 },
	{ id: 'r09', route: 'Bradford → Halifax', driver: 'Lena Fischer', status: 'delivered', date: '2026-03-06', cost: 64 },
	{ id: 'r10', route: 'Derby → Leicester', driver: 'Aisha Bello', status: 'delivered', date: '2026-03-06', cost: 119 },
	{ id: 'r11', route: 'Leicester → Coventry', driver: 'Sam Okafor', status: 'delivered', date: '2026-03-07', cost: 103 },
	{ id: 'r12', route: 'Coventry → Birmingham', driver: 'Priya Raman', status: 'delayed', date: '2026-03-07', cost: 97 },
	{ id: 'r13', route: 'Birmingham → Wolverhampton', driver: 'Marco Salas', status: 'delivered', date: '2026-03-08', cost: 71 },
	{ id: 'r14', route: 'Halifax → Huddersfield', driver: 'Aisha Bello', status: 'delivered', date: '2026-03-08', cost: 58 },
]
