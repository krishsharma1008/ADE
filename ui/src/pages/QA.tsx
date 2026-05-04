import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Bug,
  CheckCircle2,
  Download,
  FileCheck2,
  FlaskConical,
  Play,
  Plus,
  RefreshCw,
  Smartphone,
  UserPlus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Agent, QaExportFormat, QaFeedbackEvent, QaTestRun } from "@combyne/shared";
import { qaApi } from "../api/qa";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { cn } from "../lib/utils";

type QaTab = "runs" | "cases" | "suites" | "devices" | "feedback";
type QaHirePresetId = "lead" | "android" | "api" | "lender" | "web" | "regression" | "exploratory";

const QA_HIRE_PRESETS: Array<{
  id: QaHirePresetId;
  name: string;
  title: string;
  capabilities: string;
  tags: string[];
}> = [
  {
    id: "lead",
    name: "QA Lead",
    title: "QA Lead",
    capabilities: "Owns test strategy, suite assignment, final signoff, reporting, and QA-to-dev handoff.",
    tags: ["qa-lead", "signoff", "test-matrix"],
  },
  {
    id: "android",
    name: "Android QA Automation",
    title: "Android QA Automation Engineer",
    capabilities: "Runs React Native Android emulator suites, captures screenshots, video, logcat, and repro evidence.",
    tags: ["android", "react-native", "emulator", "maestro", "appium", "detox", "espresso"],
  },
  {
    id: "api",
    name: "API QA Automation",
    title: "API QA Automation Engineer",
    capabilities: "Runs REST Assured suites, parses JUnit/Surefire/Gradle results, and syncs GitHub CI API checks.",
    tags: ["api", "rest-assured", "github-ci", "junit"],
  },
  {
    id: "lender",
    name: "Lender QA Automation",
    title: "Lender QA Automation Engineer",
    capabilities: "Owns lender-domain automated suites, lender service regressions, REST Assured coverage, and handoffs.",
    tags: ["lender", "rest-assured", "regression"],
  },
  {
    id: "web",
    name: "Web QA Automation",
    title: "Web QA Automation Engineer",
    capabilities: "Runs browser automation, checks web regressions, captures artifacts, and reports reproducible failures.",
    tags: ["web", "playwright", "selenium"],
  },
  {
    id: "regression",
    name: "Regression QA",
    title: "Regression QA Engineer",
    capabilities: "Runs release candidate and cross-feature regression suites, triages known issues, and prepares exports.",
    tags: ["regression", "release-candidate", "reports"],
  },
  {
    id: "exploratory",
    name: "Exploratory QA",
    title: "Exploratory QA Engineer",
    capabilities: "Explores user flows, edge cases, usability risks, and converts findings into structured QA feedback.",
    tags: ["exploratory", "edge-cases", "handoff"],
  },
];

function downloadExport(result: { filename?: string; content?: string; contentType?: string }) {
  if (!result.content) return;
  const blob = new Blob([result.content], { type: result.contentType ?? "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename ?? "qa-report.txt";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function statusTone(status: string) {
  if (status === "passed" || status === "approved" || status === "healthy") return "text-green-500";
  if (status === "failed" || status === "blocked" || status === "unhealthy") return "text-red-500";
  if (status === "running") return "text-cyan-500";
  return "text-yellow-500";
}

function requestError(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}

export function QA() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<QaTab>("runs");
  const [hireOpen, setHireOpen] = useState(false);
  const [emulatorOpen, setEmulatorOpen] = useState(false);
  const [suiteOpen, setSuiteOpen] = useState(false);
  const [hirePresetId, setHirePresetId] = useState<QaHirePresetId>("lead");
  const [hireAdapterType, setHireAdapterType] = useState("claude_local");
  const [hireReportsTo, setHireReportsTo] = useState("");
  const [hireName, setHireName] = useState(QA_HIRE_PRESETS[0]!.name);
  const [suiteName, setSuiteName] = useState("Lender REST Assured Regression");
  const [suiteCommand, setSuiteCommand] = useState("./gradlew test");
  const [suiteRunner, setSuiteRunner] = useState("rest_assured");
  const [suitePlatform, setSuitePlatform] = useState("api");
  const [suiteParser, setSuiteParser] = useState("junit_xml");
  const [suiteService, setSuiteService] = useState("lender");
  const [suiteTimeout, setSuiteTimeout] = useState("1800");
  const [suiteTags, setSuiteTags] = useState("qa, rest_assured");
  const [deviceName, setDeviceName] = useState("Pixel_7_API_35");
  const [workerId, setWorkerId] = useState("qa-worker-local");
  const [deviceApiLevel, setDeviceApiLevel] = useState("35");
  const [deviceHealthStatus, setDeviceHealthStatus] = useState("unknown");
  const [caseTitle, setCaseTitle] = useState("Lender API returns approved callback payload");

  useEffect(() => {
    setBreadcrumbs([{ label: "QA" }]);
  }, [setBreadcrumbs]);

  const enabled = !!selectedCompanyId;
  const { data: summary } = useQuery({
    queryKey: queryKeys.qa.summary(selectedCompanyId!),
    queryFn: () => qaApi.summary(selectedCompanyId!),
    enabled,
  });
  const { data: runs } = useQuery({
    queryKey: queryKeys.qa.runs(selectedCompanyId!),
    queryFn: () => qaApi.listRuns(selectedCompanyId!),
    enabled,
    refetchInterval: 10_000,
  });
  const { data: suites } = useQuery({
    queryKey: queryKeys.qa.suites(selectedCompanyId!),
    queryFn: () => qaApi.listSuites(selectedCompanyId!),
    enabled,
  });
  const { data: cases } = useQuery({
    queryKey: queryKeys.qa.cases(selectedCompanyId!),
    queryFn: () => qaApi.listCases(selectedCompanyId!),
    enabled,
  });
  const { data: devices } = useQuery({
    queryKey: queryKeys.qa.devices(selectedCompanyId!),
    queryFn: () => qaApi.listDevices(selectedCompanyId!),
    enabled,
  });
  const { data: feedback } = useQuery({
    queryKey: queryKeys.qa.feedback(selectedCompanyId!),
    queryFn: () => qaApi.listFeedback(selectedCompanyId!),
    enabled,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled,
  });

  const qaAgents = (agents ?? []).filter((agent) => agent.role === "qa" && agent.status !== "terminated");
  const activeAgents = (agents ?? []).filter((agent) => agent.status !== "terminated");
  const pendingFeedback = (feedback ?? []).filter((event) =>
    event.status === "pending_qa_approval" || event.status === "queued",
  );
  const developerVisibleFeedback = (feedback ?? []).filter((event) =>
    event.status === "approved_for_dev" || event.status === "sent_to_dev",
  );
  const otherFeedback = (feedback ?? []).filter((event) =>
    !pendingFeedback.some((pending) => pending.id === event.id)
    && !developerVisibleFeedback.some((visible) => visible.id === event.id),
  );
  const selectedHirePreset = QA_HIRE_PRESETS.find((preset) => preset.id === hirePresetId) ?? QA_HIRE_PRESETS[0]!;
  const existingQaLead = qaAgents.find((agent) =>
    `${agent.name} ${agent.title ?? ""}`.toLowerCase().includes("lead"),
  );
  const ceoAgent = activeAgents.find((agent) => agent.role === "ceo") ?? null;
  const invalidate = () => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.qa.summary(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.qa.runs(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.qa.suites(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.qa.cases(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.qa.devices(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.qa.feedback(selectedCompanyId) });
  };

  useEffect(() => {
    setHireName(selectedHirePreset.name);
  }, [selectedHirePreset.name]);

  useEffect(() => {
    if (hirePresetId === "lead") {
      setHireReportsTo(ceoAgent?.id ?? "");
      return;
    }
    setHireReportsTo(existingQaLead?.id ?? ceoAgent?.id ?? "");
  }, [ceoAgent?.id, existingQaLead?.id, hirePresetId]);

  function setSuiteRunnerWithDefaults(runnerType: string) {
    setSuiteRunner(runnerType);
    setSuiteTags(`qa, ${runnerType}`);
    if (runnerType === "android_emulator") {
      setSuitePlatform("android");
      setSuiteParser("maestro");
      setSuiteService("");
      setSuiteCommand("maestro test .maestro");
      return;
    }
    if (runnerType === "github_ci_api") {
      setSuitePlatform("api");
      setSuiteParser("github_checks");
      setSuiteService("lender");
      setSuiteCommand("github-checks");
      return;
    }
    if (runnerType === "playwright") {
      setSuitePlatform("web");
      setSuiteParser("none");
      setSuiteService("");
      setSuiteCommand("pnpm test:e2e");
      return;
    }
    setSuitePlatform("api");
    setSuiteParser("junit_xml");
    setSuiteService(runnerType === "lender_automated" || runnerType === "rest_assured" ? "lender" : "");
    setSuiteCommand(runnerType === "rest_assured" ? "./gradlew test" : suiteCommand);
  }

  const createSuite = useMutation({
    mutationFn: () => qaApi.createSuite(selectedCompanyId!, {
      name: suiteName,
      platform: suitePlatform,
      runnerType: suiteRunner,
      service: suiteService.trim() || null,
      parserType: suiteParser,
      commandProfile: {
        command: suiteCommand.trim(),
        timeoutSec: Number.isFinite(Number(suiteTimeout)) ? Math.max(1, Math.floor(Number(suiteTimeout))) : 1800,
      },
      tags: suiteTags.split(",").map((tag) => tag.trim()).filter(Boolean),
    }),
    onSuccess: (suite) => {
      invalidate();
      setTab("suites");
      setSuiteOpen(false);
      pushToast({ title: "Suite saved", body: suite.name, tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: "Could not save suite", body: requestError(error), tone: "error" });
    },
  });

  const createCase = useMutation({
    mutationFn: () => qaApi.createCase(selectedCompanyId!, {
      title: caseTitle,
      platform: "api",
      priority: "high",
      service: "lender",
      steps: ["Send onboarding approved callback", "Validate response and persisted approvalData"],
      expectedResult: "API accepts interestRate and tenureInDays fields and preserves backward compatibility.",
      tags: ["lender", "api", "rest-assured"],
    }),
    onSuccess: (testCase) => {
      invalidate();
      setTab("cases");
      pushToast({ title: "Test case saved", body: testCase.title, tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: "Could not save test case", body: requestError(error), tone: "error" });
    },
  });

  const discoverEmulators = useMutation({
    mutationFn: () => qaApi.registerLocalEmulators(selectedCompanyId!, { workerId }),
    onSuccess: (result) => {
      invalidate();
      setTab("devices");
      if (result.registered.length > 0) {
        setEmulatorOpen(false);
        pushToast({
          title: "Emulator registered",
          body: `${result.registered.length} device${result.registered.length === 1 ? "" : "s"} discovered on ${workerId}.`,
          tone: "success",
        });
        return;
      }
      pushToast({
        title: "No local emulator found",
        body: result.diagnostics.warnings[0] ?? "Install Android SDK on a QA worker host, then try again.",
        tone: "warn",
      });
    },
    onError: (error) => {
      pushToast({ title: "Could not discover emulator", body: requestError(error), tone: "error" });
    },
  });

  const registerDevice = useMutation({
    mutationFn: () => qaApi.registerDevice(selectedCompanyId!, {
      workerId,
      name: deviceName,
      kind: "android_emulator",
      platform: "android",
      apiLevel: deviceApiLevel.trim() || null,
      healthStatus: deviceHealthStatus,
      capabilities: {
        reactNative: true,
        emulatorFirst: true,
        frameworks: ["maestro", "appium", "detox", "espresso", "custom"],
        java: true,
        node: true,
        gradle: true,
        maven: true,
      },
    }),
    onSuccess: (device) => {
      invalidate();
      setTab("devices");
      setEmulatorOpen(false);
      pushToast({ title: "Emulator registered", body: `${device.workerId} · ${device.name}`, tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: "Could not register emulator", body: requestError(error), tone: "error" });
    },
  });

  const createRun = useMutation({
    mutationFn: (suiteId: string | null) => {
      const suite = (suites ?? []).find((s) => s.id === suiteId) ?? null;
      return qaApi.createRun(selectedCompanyId!, {
        suiteId,
        qaAgentId: qaAgents[0]?.id ?? null,
        title: suite ? `QA run — ${suite.name}` : "QA run",
        platform: suite?.platform ?? "api",
        runnerType: suite?.runnerType ?? "custom_command",
        service: suite?.service ?? null,
        parserType: suite?.parserType ?? "none",
      });
    },
    onSuccess: (run) => {
      invalidate();
      setTab("runs");
      pushToast({ title: "QA run queued", body: run.title, tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: "Could not queue QA run", body: requestError(error), tone: "error" });
    },
  });

  const exportRun = useMutation({
    mutationFn: ({ run, format }: { run: QaTestRun; format: QaExportFormat }) => qaApi.exportRun(run.id, { format }),
    onSuccess: (result) => {
      if (result.content) downloadExport(result);
      invalidate();
      pushToast({
        title: result.format === "jira" ? "Jira export prepared" : "Report downloaded",
        body: result.filename,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({ title: "Could not export QA report", body: requestError(error), tone: "error" });
    },
  });

  const approveFeedback = useMutation({
    mutationFn: (event: QaFeedbackEvent) => qaApi.approveFeedback(event.id, {
      note: "Approved by QA from the QA workspace.",
    }),
    onSuccess: (event) => {
      invalidate();
      pushToast({
        title: "Feedback approved",
        body: `${event.title} is now visible to developers.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({ title: "Could not approve feedback", body: requestError(error), tone: "error" });
    },
  });

  const hireQaAgent = useMutation({
    mutationFn: () => agentsApi.hire(selectedCompanyId!, {
      name: hireName.trim(),
      role: "qa",
      title: selectedHirePreset.title,
      icon: "bot",
      capabilities: selectedHirePreset.capabilities,
      ...(hireReportsTo ? { reportsTo: hireReportsTo } : {}),
      adapterType: hireAdapterType,
      adapterConfig: {
        combyneSkillSync: {
          desiredSkills: ["qa-engineer"],
        },
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          intervalSec: 300,
          wakeOnDemand: true,
          cooldownSec: 10,
          maxConcurrentRuns: 1,
        },
      },
      budgetMonthlyCents: 0,
      metadata: {
        createdFrom: "qa_workspace",
        qaPreset: selectedHirePreset.id,
        qaCapabilities: selectedHirePreset.tags,
        canGenerateTestCases: true,
        canExecuteQaRuns: true,
        canSendDeveloperFeedback: true,
      },
    }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      setHireOpen(false);
      pushToast({
        title: result.agent.status === "pending_approval" ? "QA hire requested" : "QA agent hired",
        body: result.agent.status === "pending_approval"
          ? `${result.agent.name} is waiting for board approval.`
          : `${result.agent.name} is ready for QA work.`,
        tone: result.agent.status === "pending_approval" ? "info" : "success",
        action: result.agent.status === "pending_approval"
          ? { label: "Review", href: "/approvals/pending" }
          : undefined,
      });
    },
    onError: (error) => {
      pushToast({ title: "Could not hire QA agent", body: requestError(error), tone: "error" });
    },
  });

  if (!selectedCompanyId) return <EmptyState icon={FlaskConical} message="Select a company to manage QA." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-xl font-bold">QA</h1>
          <p className="text-sm text-muted-foreground">
            Test cases, Android workers, API automation, reports, and developer handoffs.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setEmulatorOpen(true)}>
            <Smartphone className="mr-1.5 h-4 w-4" />
            Register emulator
          </Button>
          <Button variant="outline" onClick={() => setHireOpen(true)}>
            <UserPlus className="mr-1.5 h-4 w-4" />
            Hire QA
          </Button>
          <Button onClick={() => setSuiteOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add suite
          </Button>
        </div>
      </div>

      <Dialog open={emulatorOpen} onOpenChange={setEmulatorOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Register emulator</DialogTitle>
            <DialogDescription>
              Discover Android SDK emulators on this host or register a QA worker device manually.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-2 md:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="qa-worker-id">Worker id</Label>
                <Input id="qa-worker-id" value={workerId} onChange={(event) => setWorkerId(event.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="qa-device-name">Device name</Label>
                <Input id="qa-device-name" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="qa-device-api">Android API level</Label>
                <Input id="qa-device-api" value={deviceApiLevel} onChange={(event) => setDeviceApiLevel(event.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="qa-device-health">Health</Label>
                <Select value={deviceHealthStatus} onValueChange={setDeviceHealthStatus}>
                  <SelectTrigger id="qa-device-health" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unknown">Unknown</SelectItem>
                    <SelectItem value="healthy">Healthy</SelectItem>
                    <SelectItem value="unhealthy">Unhealthy</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {discoverEmulators.data && (
              <div className="rounded-md border border-border bg-card px-3 py-2">
                <div className="text-xs font-medium text-muted-foreground">Discovery result</div>
                <div className="mt-1 text-sm">
                  {discoverEmulators.data.registered.length > 0
                    ? `${discoverEmulators.data.registered.length} device${discoverEmulators.data.registered.length === 1 ? "" : "s"} registered`
                    : "No emulator detected"}
                </div>
                {discoverEmulators.data.diagnostics.warnings.length > 0 && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {discoverEmulators.data.diagnostics.warnings.join(" ")}
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEmulatorOpen(false)}>Cancel</Button>
            <Button variant="outline" onClick={() => discoverEmulators.mutate()} disabled={!workerId.trim() || discoverEmulators.isPending}>
              {discoverEmulators.isPending ? "Discovering..." : "Auto-discover"}
            </Button>
            <Button onClick={() => registerDevice.mutate()} disabled={!workerId.trim() || !deviceName.trim() || registerDevice.isPending}>
              {registerDevice.isPending ? "Saving..." : "Register manually"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={suiteOpen} onOpenChange={setSuiteOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add suite</DialogTitle>
            <DialogDescription>
              Configure the runner, command, parser, and service metadata for a reusable QA suite.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="qa-suite-name">Suite name</Label>
              <Input id="qa-suite-name" value={suiteName} onChange={(event) => setSuiteName(event.target.value)} />
            </div>

            <div className="grid gap-2 md:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="qa-suite-runner">Runner</Label>
                <Select value={suiteRunner} onValueChange={setSuiteRunnerWithDefaults}>
                  <SelectTrigger id="qa-suite-runner" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="android_emulator">Android emulator</SelectItem>
                    <SelectItem value="lender_automated">Lender automated</SelectItem>
                    <SelectItem value="github_ci_api">GitHub CI API</SelectItem>
                    <SelectItem value="rest_assured">REST Assured</SelectItem>
                    <SelectItem value="playwright">Playwright</SelectItem>
                    <SelectItem value="selenium">Selenium</SelectItem>
                    <SelectItem value="custom_command">Custom command</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="qa-suite-platform">Platform</Label>
                <Select value={suitePlatform} onValueChange={setSuitePlatform}>
                  <SelectTrigger id="qa-suite-platform" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="api">API</SelectItem>
                    <SelectItem value="android">Android</SelectItem>
                    <SelectItem value="web">Web</SelectItem>
                    <SelectItem value="ios">iOS</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="qa-suite-parser">Parser</Label>
                <Select value={suiteParser} onValueChange={setSuiteParser}>
                  <SelectTrigger id="qa-suite-parser" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="junit_xml">JUnit XML</SelectItem>
                    <SelectItem value="surefire">Surefire</SelectItem>
                    <SelectItem value="gradle">Gradle</SelectItem>
                    <SelectItem value="github_checks">GitHub checks</SelectItem>
                    <SelectItem value="maestro">Maestro</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-[1fr_8rem]">
              <div className="grid gap-1.5">
                <Label htmlFor="qa-suite-command">Command</Label>
                <Input id="qa-suite-command" value={suiteCommand} onChange={(event) => setSuiteCommand(event.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="qa-suite-timeout">Timeout sec</Label>
                <Input id="qa-suite-timeout" value={suiteTimeout} onChange={(event) => setSuiteTimeout(event.target.value)} />
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="qa-suite-service">Service</Label>
                <Input id="qa-suite-service" value={suiteService} onChange={(event) => setSuiteService(event.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="qa-suite-tags">Tags</Label>
                <Input id="qa-suite-tags" value={suiteTags} onChange={(event) => setSuiteTags(event.target.value)} />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSuiteOpen(false)}>Cancel</Button>
            <Button onClick={() => createSuite.mutate()} disabled={!suiteName.trim() || createSuite.isPending}>
              {createSuite.isPending ? "Saving..." : "Save suite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={hireOpen} onOpenChange={setHireOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Hire QA agent</DialogTitle>
            <DialogDescription>
              Create a QA agent with the QA Engineer skill attached to its runtime configuration.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="qa-hire-preset">QA role</Label>
              <Select value={hirePresetId} onValueChange={(value) => setHirePresetId(value as QaHirePresetId)}>
                <SelectTrigger id="qa-hire-preset" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QA_HIRE_PRESETS.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>{preset.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="qa-hire-name">Name</Label>
              <Input id="qa-hire-name" value={hireName} onChange={(event) => setHireName(event.target.value)} />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="qa-hire-manager">Reports to</Label>
              <Select value={hireReportsTo || "none"} onValueChange={(value) => setHireReportsTo(value === "none" ? "" : value)}>
                <SelectTrigger id="qa-hire-manager" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No manager</SelectItem>
                  {activeAgents.map((agent: Agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name} · {agent.role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="qa-hire-adapter">Runtime</Label>
              <Select value={hireAdapterType} onValueChange={setHireAdapterType}>
                <SelectTrigger id="qa-hire-adapter" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude_local">Claude local</SelectItem>
                  <SelectItem value="codex_local">Codex local</SelectItem>
                  <SelectItem value="cursor">Cursor</SelectItem>
                  <SelectItem value="process">Process</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-md border border-border bg-card px-3 py-2">
              <div className="text-sm font-medium">{selectedHirePreset.title}</div>
              <div className="mt-1 text-xs text-muted-foreground">{selectedHirePreset.capabilities}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {selectedHirePreset.tags.map((tag) => (
                  <span key={tag} className="rounded-sm border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setHireOpen(false)}>Cancel</Button>
            <Button onClick={() => hireQaAgent.mutate()} disabled={!hireName.trim() || hireQaAgent.isPending}>
              {hireQaAgent.isPending ? "Hiring..." : "Hire QA"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-3 md:grid-cols-4">
        <Metric icon={Play} label="Runs" value={String(runs?.length ?? 0)} />
        <Metric icon={Bug} label="Feedback" value={String(feedback?.length ?? 0)} />
        <Metric icon={Smartphone} label="Devices" value={String(devices?.length ?? 0)} />
        <Metric icon={Bot} label="QA agents" value={String(qaAgents.length)} />
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as QaTab)} className="space-y-3">
        <TabsList variant="line" className="w-full justify-start">
          <TabsTrigger value="runs">Test Runs</TabsTrigger>
          <TabsTrigger value="cases">Test Cases</TabsTrigger>
          <TabsTrigger value="suites">Suites</TabsTrigger>
          <TabsTrigger value="devices">Android Devices</TabsTrigger>
          <TabsTrigger value="feedback">Feedback Queue</TabsTrigger>
        </TabsList>

        <TabsContent value="runs" className="space-y-2">
          {(runs ?? []).length === 0 ? (
            <EmptyState icon={FileCheck2} message="No QA runs yet." />
          ) : (
            (runs ?? []).map((run) => (
              <div key={run.id} className="rounded-md border border-border px-3 py-2">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{run.title}</span>
                      <StatusBadge status={run.status} />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{run.platform}</span>
                      <span>{run.runnerType}</span>
                      {run.service && <span>{run.service}</span>}
                      {run.repo && <span>{run.repo}{run.pullNumber ? `#${run.pullNumber}` : ""}</span>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => exportRun.mutate({ run, format: "pdf" })}>
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                      PDF
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => exportRun.mutate({ run, format: "csv" })}>CSV</Button>
                    <Button size="sm" variant="outline" onClick={() => exportRun.mutate({ run, format: "jira" })}>Jira</Button>
                  </div>
                </div>
                <div className={cn("mt-2 text-xs font-medium", statusTone(run.status))}>
                  {run.summary ?? run.conclusion}
                </div>
              </div>
            ))
          )}
        </TabsContent>

        <TabsContent value="cases" className="space-y-3">
          <div className="rounded-md border border-border p-3">
            <div className="grid gap-2 md:grid-cols-[1fr_auto]">
              <Input value={caseTitle} onChange={(e) => setCaseTitle(e.target.value)} />
              <Button onClick={() => createCase.mutate()} disabled={createCase.isPending}>
                <Plus className="mr-1.5 h-4 w-4" />
                {createCase.isPending ? "Saving..." : "Add case"}
              </Button>
            </div>
          </div>
          {(cases ?? []).map((testCase) => (
            <div key={testCase.id} className="rounded-md border border-border px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{testCase.title}</div>
                  <div className="text-xs text-muted-foreground">{testCase.platform} · {testCase.service ?? "no service"} · {testCase.priority}</div>
                </div>
                <StatusBadge status={testCase.status} />
              </div>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="suites" className="space-y-3">
          <div className="rounded-md border border-border p-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{suiteName}</div>
                <div className="text-xs text-muted-foreground">{suitePlatform} · {suiteRunner} · {suiteParser}</div>
              </div>
              <Button variant="outline" onClick={() => setSuiteOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                Configure suite
              </Button>
            </div>
          </div>
          {(suites ?? []).map((suite) => (
            <div key={suite.id} className="rounded-md border border-border px-3 py-2">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="text-sm font-medium">{suite.name}</div>
                  <div className="text-xs text-muted-foreground">{suite.platform} · {suite.runnerType} · {suite.parserType}</div>
                </div>
                <Button size="sm" variant="outline" onClick={() => createRun.mutate(suite.id)} disabled={createRun.isPending}>
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  {createRun.isPending ? "Queueing..." : "Queue run"}
                </Button>
              </div>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="devices" className="space-y-3">
          <div className="rounded-md border border-border p-3">
            <div className="grid gap-2 md:grid-cols-[1fr_1fr_7rem_9rem_auto]">
              <Input value={workerId} onChange={(e) => setWorkerId(e.target.value)} />
              <Input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
              <Input value={deviceApiLevel} onChange={(e) => setDeviceApiLevel(e.target.value)} />
              <Select value={deviceHealthStatus} onValueChange={setDeviceHealthStatus}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unknown">Unknown</SelectItem>
                  <SelectItem value="healthy">Healthy</SelectItem>
                  <SelectItem value="unhealthy">Unhealthy</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={() => registerDevice.mutate()} disabled={registerDevice.isPending}>
                <RefreshCw className="mr-1.5 h-4 w-4" />
                {registerDevice.isPending ? "Saving..." : "Health record"}
              </Button>
            </div>
          </div>
          {(devices ?? []).map((device) => (
            <div key={device.id} className="rounded-md border border-border px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">{device.name}</div>
                  <div className="text-xs text-muted-foreground">{device.workerId} · API {device.apiLevel ?? "unknown"}</div>
                </div>
                <span className={cn("text-xs font-medium", statusTone(device.healthStatus))}>{device.healthStatus}</span>
              </div>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="feedback" className="space-y-4">
          {(feedback ?? []).length === 0 ? (
            <EmptyState icon={CheckCircle2} message="No QA feedback waiting." />
          ) : (
            <>
              {pendingFeedback.length > 0 && (
                <FeedbackSection
                  title="Pending QA approval"
                  description="QA-created failures stay private to QA until a human approves the developer handoff."
                  events={pendingFeedback}
                  action={(event) => (
                    <Button
                      size="sm"
                      onClick={() => approveFeedback.mutate(event)}
                      disabled={approveFeedback.isPending}
                    >
                      <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                      Approve for devs
                    </Button>
                  )}
                />
              )}

              {developerVisibleFeedback.length > 0 && (
                <FeedbackSection
                  title="Developer-visible feedback"
                  description="Approved QA feedback from the central DB. Developers can use this queue for fixes and follow-up work."
                  events={developerVisibleFeedback}
                />
              )}

              {otherFeedback.length > 0 && (
                <FeedbackSection
                  title="Other feedback"
                  description="Deferred, known issue, acknowledged, and resolved QA records."
                  events={otherFeedback}
                />
              )}
            </>
          )}
        </TabsContent>
      </Tabs>

      <div className="hidden">{JSON.stringify(summary?.runCounts ?? {})}</div>
    </div>
  );
}

function Metric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

function FeedbackSection({
  title,
  description,
  events,
  action,
}: {
  title: string;
  description: string;
  events: QaFeedbackEvent[];
  action?: (event: QaFeedbackEvent) => ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      {events.map((event) => (
        <div key={event.id} className="rounded-md border border-border px-3 py-2">
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-medium">{event.title}</div>
              <div className="text-xs text-muted-foreground">
                {event.severity} · {event.status} · {event.issueId ? "linked issue" : "no issue"}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={event.status} />
              {action?.(event)}
            </div>
          </div>
          <Textarea className="mt-2 min-h-20 text-xs" value={event.body} readOnly />
        </div>
      ))}
    </section>
  );
}
