import type {
  QaArtifact,
  QaArtifactCreate,
  QaDevice,
  QaDeviceDiscoveryResult,
  QaDeviceRegister,
  QaEnvironment,
  QaEnvironmentUpsert,
  QaExport,
  QaExportResult,
  QaFeedbackApprove,
  QaFeedbackEvent,
  QaFeedbackSend,
  QaRunDetail,
  QaSignoff,
  QaSummary,
  QaTestCase,
  QaTestCaseCreate,
  QaTestResult,
  QaTestResultCreate,
  QaTestRun,
  QaTestRunCreate,
  QaTestRunUpdate,
  QaTestSuite,
  QaTestSuiteCreate,
} from "@combyne/shared";
import { api } from "./client";

export const qaApi = {
  summary: (companyId: string) => api.get<QaSummary>(`/companies/${companyId}/qa/summary`),
  listCases: (companyId: string) => api.get<QaTestCase[]>(`/companies/${companyId}/qa/test-cases`),
  createCase: (companyId: string, body: QaTestCaseCreate) =>
    api.post<QaTestCase>(`/companies/${companyId}/qa/test-cases`, body),
  listSuites: (companyId: string) => api.get<QaTestSuite[]>(`/companies/${companyId}/qa/suites`),
  createSuite: (companyId: string, body: QaTestSuiteCreate) =>
    api.post<QaTestSuite>(`/companies/${companyId}/qa/suites`, body),
  listEnvironments: (companyId: string) => api.get<QaEnvironment[]>(`/companies/${companyId}/qa/environments`),
  createEnvironment: (companyId: string, body: QaEnvironmentUpsert) =>
    api.post<QaEnvironment>(`/companies/${companyId}/qa/environments`, body),
  listDevices: (companyId: string) => api.get<QaDevice[]>(`/companies/${companyId}/qa/devices`),
  registerDevice: (companyId: string, body: QaDeviceRegister) =>
    api.post<QaDevice>(`/companies/${companyId}/qa/devices/register`, body),
  registerLocalEmulators: (companyId: string, body: { workerId?: string }) =>
    api.post<QaDeviceDiscoveryResult>(`/companies/${companyId}/qa/devices/register-local-emulators`, body),
  listRuns: (companyId: string, issueId?: string) =>
    api.get<QaTestRun[]>(`/companies/${companyId}/qa/runs${issueId ? `?issueId=${encodeURIComponent(issueId)}` : ""}`),
  createRun: (companyId: string, body: QaTestRunCreate) =>
    api.post<QaTestRun>(`/companies/${companyId}/qa/runs`, body),
  getRun: (runId: string) => api.get<QaRunDetail>(`/qa/runs/${runId}`),
  updateRun: (runId: string, body: QaTestRunUpdate) => api.patch<QaTestRun>(`/qa/runs/${runId}`, body),
  addResult: (runId: string, body: QaTestResultCreate) =>
    api.post<QaTestResult>(`/qa/runs/${runId}/results`, body),
  addArtifact: (runId: string, body: QaArtifactCreate) =>
    api.post<QaArtifact>(`/qa/runs/${runId}/artifacts`, body),
  syncGitHubCi: (runId: string) => api.post<QaTestRun>(`/qa/runs/${runId}/sync-github-ci`, {}),
  sendFeedback: (runId: string, body: QaFeedbackSend) =>
    api.post<QaFeedbackEvent>(`/qa/runs/${runId}/feedback/send`, body),
  approveFeedback: (feedbackId: string, body: QaFeedbackApprove) =>
    api.post<QaFeedbackEvent>(`/qa/feedback/${feedbackId}/approve`, body),
  signoff: (runId: string, body: QaSignoff) => api.post<QaTestRun>(`/qa/runs/${runId}/signoff`, body),
  exportRun: (runId: string, body: QaExport) => api.post<QaExportResult>(`/qa/runs/${runId}/export`, body),
  listFeedback: (companyId: string) => api.get<QaFeedbackEvent[]>(`/companies/${companyId}/qa/feedback`),
};
