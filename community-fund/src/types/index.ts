/**
 * Shared TypeScript types across all layers.
 * All domain models are defined here to ensure consistency.
 */

// ---------------------------------------------------------------------------
// Member & Identity
// ---------------------------------------------------------------------------

export interface Member {
  id: string;
  walletAddress: string;       // Open Payments wallet address
  name: string;
  email: string;
  location: string;            // Used for location-based disaster triggers
  consentGiven: boolean;       // GDPR-style consent for data processing
  consentTimestamp: string;
  createdAt: string;
}

export interface MemberRegistrationPayload {
  walletAddress: string;
  name: string;
  email: string;
  location: string;
  consentGiven: boolean;
}

// ---------------------------------------------------------------------------
// Contributions (Inbound Flow)
// ---------------------------------------------------------------------------

export type ContributionFrequency = "daily" | "weekly" | "monthly" | "one-off";

export interface Contribution {
  id: string;
  memberId: string;
  amount: number;              // In smallest currency unit (e.g. cents)
  currency: string;            // ISO 4217 (e.g. "USD")
  frequency: ContributionFrequency;
  opGrantId: string;           // Open Payments grant ID for recurring auth
  opIncomingPaymentId: string; // Open Payments incoming payment resource ID
  status: "pending" | "completed" | "failed";
  createdAt: string;
}

export interface ContributionPayload {
  memberId: string;
  amount: number;
  currency: string;
  frequency: ContributionFrequency;
}

// ---------------------------------------------------------------------------
// Fund Pool
// ---------------------------------------------------------------------------

export interface FundPool {
  id: string;
  totalBalance: number;
  currency: string;
  lastUpdated: string;
}

// ---------------------------------------------------------------------------
// Disaster Triggers
// ---------------------------------------------------------------------------

export type DisasterType = "earthquake" | "flood" | "typhoon" | "hurricane" | "other";

export interface DisasterSignal {
  id: string;
  type: DisasterType;
  severity: number;            // 1-10 scale
  location: string;
  sourceApi: string;           // e.g. "USGS", "WeatherGov"
  sourceUrl: string;           // Direct link to the raw signal for audit
  rawPayload: string;          // JSON stringified raw API response
  verified: boolean;           // Set by AI verification layer if enabled
  verificationNote: string;
  detectedAt: string;
}

// ---------------------------------------------------------------------------
// Payout Rules (Rule Engine)
// ---------------------------------------------------------------------------

export type DistributionMethod =
  | "equal_split"
  | "severity_based"
  | "household_size"
  | "capped_payout";

export interface PayoutRule {
  id: string;
  name: string;
  distributionMethod: DistributionMethod;
  maxPayoutPerMember: number;  // Cap per member per disaster event
  eligibilityRadiusKm: number; // Location radius to qualify for payout
  minSeverityThreshold: number; // Minimum disaster severity score (1-10)
  proposedBy: string;          // Member ID who proposed the rule
  approvedAt: string | null;
  active: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Payouts (Outbound Flow)
// ---------------------------------------------------------------------------

export interface Payout {
  id: string;
  disasterSignalId: string;
  memberId: string;
  amount: number;
  currency: string;
  ruleId: string;              // Which rule was applied
  opOutgoingPaymentId: string; // Open Payments outgoing payment resource ID
  status: "pending" | "completed" | "failed";
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export type ProposalType = "rule_change" | "threshold_change" | "trigger_definition";
export type VoteChoice = "yes" | "no" | "abstain";

export interface Proposal {
  id: string;
  type: ProposalType;
  title: string;
  description: string;
  proposedBy: string;          // Member ID
  payload: string;             // JSON stringified proposed change
  votesYes: number;
  votesNo: number;
  votesAbstain: number;
  status: "open" | "passed" | "rejected" | "expired";
  expiresAt: string;
  createdAt: string;
}

export interface Vote {
  id: string;
  proposalId: string;
  memberId: string;
  choice: VoteChoice;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Event Log (Append-only audit chain)
// ---------------------------------------------------------------------------

export type EventType =
  | "member_registered"
  | "contribution_received"
  | "disaster_signal_detected"
  | "disaster_signal_verified"
  | "payout_triggered"
  | "payout_completed"
  | "rule_proposed"
  | "rule_approved"
  | "vote_cast";

export interface AuditEvent {
  id: string;
  type: EventType;
  payload: string;             // JSON stringified event data
  opTxId: string | null;       // Open Payments transaction ID if applicable
  prevHash: string;            // Hash of previous event (chain integrity)
  hash: string;                // SHA-256 of (prevHash + type + payload + timestamp)
  timestamp: string;
}

// ---------------------------------------------------------------------------
// API Responses
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
