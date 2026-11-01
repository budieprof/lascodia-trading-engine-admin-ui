/** Engine DTOs of trade surveillance (gaps program; engine `docs/api/surveillance-api.md`). */

export type SurveillanceStatus = 'Open' | 'UnderReview' | 'Closed';
export type SurveillanceResolution = 'FalsePositive' | 'Escalated' | 'Actioned';
export type SurveillanceSeverity = 'Low' | 'Medium' | 'High' | 'Critical';
export type SurveillanceEventKind =
  | 'Raised'
  | 'Assigned'
  | 'StatusChanged'
  | 'Note'
  | 'Notified'
  | 'Updated';

export interface SurveillanceAlertItem {
  id: number;
  detector: string;
  detectorName: string;
  severity: SurveillanceSeverity;
  status: SurveillanceStatus;
  resolution: SurveillanceResolution | null;
  tradingAccountId: number | null;
  account: string | null;
  symbol: string | null;
  title: string;
  score: number | null;
  windowStartUtc: string;
  windowEndUtc: string;
  detectedAtUtc: string;
  lastSeenAtUtc: string;
  lastTransitionAtUtc: string;
  assignedTo: string | null;
  assignedToDisplay: string | null;
  notifiedAtUtc: string | null;
}

export interface SurveillanceAlertPage {
  items: SurveillanceAlertItem[];
  total: number;
  page: number;
  pageSize: number;
  statusCounts: Record<string, number>;
  activeByDetector: Record<string, number>;
  notice: string;
}

export interface SurveillanceAlertEvent {
  id: number;
  kind: SurveillanceEventKind;
  fromStatus: SurveillanceStatus | null;
  toStatus: SurveillanceStatus | null;
  resolution: SurveillanceResolution | null;
  note: string | null;
  actor: string;
  actorDisplay: string | null;
  occurredAtUtc: string;
}

export interface EvidenceOrder {
  id: number;
  accountId: number;
  symbol: string;
  isBuy: boolean;
  side: string;
  executionType: string;
  status: string;
  quantity: number;
  price: number;
  createdAtUtc: string;
  filledAtUtc: string | null;
  filledPrice: number | null;
  fillQuantity: number;
  cancelledAtUtc: string | null;
}

export interface EvidencePosition {
  id: number;
  accountId: number;
  symbol: string;
  isLong: boolean;
  lots: number;
  averageEntryPrice: number;
  openedAtUtc: string;
  closedAtUtc: string | null;
  netPnl: number | null;
  isOpen: boolean;
}

export interface SurveillanceEvidence {
  orders?: EvidenceOrder[];
  ordersOmitted?: number;
  positions?: EvidencePosition[];
  quotes?: { label: string; symbol: string; atUtc: string; bid: number; ask: number }[];
  metrics?: Record<string, unknown>;
  thresholds?: Record<string, number>;
  timeline?: { atUtc: string; text: string; orderId: number | null }[];
}

export interface SurveillanceAlertDetail {
  alert: SurveillanceAlertItem;
  summary: string;
  detectorDescription: string;
  evidence: SurveillanceEvidence;
  events: SurveillanceAlertEvent[];
  nextStatuses: SurveillanceStatus[];
  notice: string;
}

export interface SurveillanceAlertFilter {
  status?: SurveillanceStatus | null;
  detector?: string | null;
  minSeverity?: SurveillanceSeverity | null;
  symbol?: string | null;
  mine?: boolean;
  page?: number;
  pageSize?: number;
}

export interface TransitionBody {
  status: SurveillanceStatus;
  resolution?: SurveillanceResolution | null;
  note?: string | null;
}

// ── Settings / operations ──

export type ConfigDataType = 'String' | 'Int' | 'Decimal' | 'Bool' | 'Json';

export interface SurveillanceKey {
  key: string;
  value: string | null;
  default: string;
  dataType: ConfigDataType;
  description: string;
  lastChangedAtUtc: string | null;
  lastChangedBy: string | null;
}

export interface SurveillanceParameter {
  name: string;
  configKey: string;
  value: number;
  default: number;
  min: number;
  max: number;
  description: string;
}

export interface SurveillanceDetector {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  severity: SurveillanceSeverity;
  parameters: SurveillanceParameter[];
}

export interface SurveillanceConfiguration {
  enabled: boolean;
  pollIntervalSeconds: number;
  lookbackHours: number;
  notify: boolean;
  notifyMinSeverity: SurveillanceSeverity;
  detectors: SurveillanceDetector[];
  keys: SurveillanceKey[];
  canEdit: boolean;
  notice: string;
}

export interface JobStatus {
  jobName: string;
  lastStartedAtUtc: string | null;
  lastFinishedAtUtc: string | null;
  lastOutcome: 'Succeeded' | 'Failed' | 'Skipped' | null;
  lastMessage: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  nextRunAtUtc: string | null;
  runRequestedAtUtc: string | null;
  runRequestedBy: string | null;
  detail: {
    lastAnchor?: {
      eventId: number;
      hash: string;
      source: string;
      publishedAtUtc: string;
      signed: boolean;
    } | null;
    targets?: { target: string; ok: boolean }[] | null;
    previousHeadCheck?: string;
    problems?: { problem: string; detail: string }[] | null;
  } | null;
}

export interface AnchorOperations {
  configured: boolean;
  problems: string[];
  intervalHours: number;
  macKeySet: boolean;
  filePath: string | null;
  webhookHost: string | null;
  s3: {
    endpoint: string;
    bucket: string;
    region: string;
    prefix: string;
    retentionDays: number;
    lockMode: string;
    pathStyle: boolean;
    accessKeyId: string;
    secretAccessKeySet: boolean;
    sessionTokenSet: boolean;
  } | null;
  status: JobStatus;
  operatorSteps: string[];
}

export interface SurveillanceOperations {
  scan: JobStatus;
  canManage: boolean;
  anchors: AnchorOperations | null;
}

// ── Regulatory reports (fund/compliance) ──

export type RegulatoryKind = 'mifir-rts22' | 'emir-refit' | 'rts28-venues';
export type ClientIdType = 'Lei' | 'NationalId' | 'Concat';

export interface RegulatoryFirm {
  firmLei: string | null;
  firmCountry: string | null;
  investmentFirmCoveredByMifid: boolean;
  defaultVenueMic: string;
  investmentDecisionCode: string | null;
  investmentDecisionIsAlgorithm: boolean;
  executionDecisionCode: string | null;
  executionDecisionIsAlgorithm: boolean;
  emirCounterpartyNature: string | null;
  emirCorporateSector: string | null;
  updatedBy?: string | null;
  updatedAtUtc?: string | null;
}

export interface RegulatoryAccount {
  tradingAccountId: number;
  account: string;
  brokerServer: string;
  accountType: 'Demo' | 'Real' | 'Contest';
  configured: boolean;
  clientIdType: ClientIdType;
  clientIdentifier: string | null;
  clientCountry: string | null;
  counterpartyLei: string | null;
  venueMic: string | null;
  updatedBy: string | null;
  updatedAtUtc: string | null;
}

export interface RegulatoryReferenceData {
  firm: RegulatoryFirm;
  accounts: RegulatoryAccount[];
  problems: { field: string; problem: string }[];
  notice: string;
}

export interface RegulatoryIssue {
  severity: 'error' | 'warning';
  record: string;
  field: string;
  message: string;
}

export interface RegulatoryPreview {
  kind: RegulatoryKind;
  title: string;
  schemaNote: string;
  fromUtc: string;
  toUtc: string;
  records: number;
  errors: number;
  warnings: number;
  complete: boolean;
  hasXml: boolean;
  issues: RegulatoryIssue[];
  issuesOmitted: number;
  notes: string[];
  columns: string[];
  sample: Record<string, string | null>[];
  canSign: boolean;
  notice: string;
}
