/** A coach's client. FTP/HRmax drive every analysis run for their rides. */
export interface Client {
  id: string
  coach_id: string
  name: string
  email: string | null
  ftp: number | null
  hr_max: number | null
  weight_kg: number | null
  goal_event: string | null
  goal_date: string | null
  weekly_hours: number | null
  training_phase: string | null
  notes: string | null
  archived: boolean
  created_at: string
}

export type SessionIntensity =
  | 'rest' | 'recovery' | 'endurance' | 'tempo' | 'threshold' | 'vo2max' | 'anaerobic' | 'race' | 'test' | 'unknown'

/** One prescribed session, extracted from the plan PDF. */
export interface PlanSession {
  id: string
  plan_id: string
  client_id: string
  /** 1-based week within the plan. */
  week: number
  /** 1 = Monday … 7 = Sunday. */
  dayOfWeek: number
  /** Resolved calendar date, once the plan has a start date. */
  date: string | null
  title: string
  description: string | null
  sport: string | null
  durationSecs: number | null
  targetLoad: number | null
  intensity: SessionIntensity
  /** The raw text this session was read from — the audit trail back to the PDF. */
  sourceText: string | null
}

export interface TrainingPlan {
  id: string
  client_id: string
  filename: string
  planName: string | null
  startDate: string | null
  weeks: number | null
  status: 'draft' | 'active' | 'archived'
  created_at: string
}
