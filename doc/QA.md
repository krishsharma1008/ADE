# QA Function

Combyne QA is a first-class company-scoped workflow for reusable test cases, test suites, structured test runs, artifacts, exports, and developer handoff.

## Roles

- QA Lead plans suites, assigns QA runs, and approves final QA signoff.
- Android QA runs React Native Android validation on registered emulator workers.
- API QA runs or reconciles REST Assured, lender automated suites, and GitHub CI/CD API checks.
- Web QA runs Playwright/Selenium suites.

## Core Flow

1. Create reusable cases and suites in the QA workspace.
2. Register Android QA worker/emulator capability when mobile testing is needed.
3. Create a QA run linked to an issue, PR, repo, service, and build SHA when available.
4. Record results through JUnit XML, GitHub CI sync, or direct result submission.
5. Attach artifacts such as screenshots, video, logcat, command logs, REST Assured reports, and GitHub check logs.
6. Send failed QA feedback to the developer agent/operator through the structured feedback endpoint.
7. Export PDF, CSV, or Jira reports.
8. Human QA Lead approves final signoff for release readiness.

## Supported Runner Types

- `android_emulator`: React Native Android emulator testing. Supports Maestro/Appium/Detox/Espresso/custom command profiles.
- `lender_automated`: lender-domain automated test commands configured per suite/service.
- `rest_assured`: Java API suites with Maven/Gradle commands and JUnit/Surefire/Gradle XML parsing.
- `github_ci_api`: reads GitHub Actions/check-run status for API tests without requiring local git paths.
- `playwright` and `selenium`: web validation.
- `custom_command`: fallback for team-specific automation.

## Main APIs

- `GET /api/companies/:companyId/qa/summary`
- `GET|POST /api/companies/:companyId/qa/test-cases`
- `GET|POST /api/companies/:companyId/qa/suites`
- `GET|POST /api/companies/:companyId/qa/environments`
- `GET /api/companies/:companyId/qa/devices`
- `POST /api/companies/:companyId/qa/devices/register`
- `GET|POST /api/companies/:companyId/qa/runs`
- `GET|PATCH /api/qa/runs/:runId`
- `POST /api/qa/runs/:runId/results`
- `POST /api/qa/runs/:runId/results/junit`
- `POST /api/qa/runs/:runId/artifacts`
- `POST /api/qa/runs/:runId/sync-github-ci`
- `POST /api/qa/runs/:runId/feedback/send`
- `POST /api/qa/runs/:runId/signoff`
- `POST /api/qa/runs/:runId/export`

## UI

- Company QA workspace: `/:companyPrefix/qa`
- Issue-level QA panel: visible on issue detail pages.

The QA workspace supports test runs, reusable cases, suites, Android devices, export actions, and feedback queue visibility. The issue panel supports creating QA runs, syncing GitHub CI checks, sending failed results to developers, exporting reports, and human QA signoff.
