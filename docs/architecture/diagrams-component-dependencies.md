# Component & Dependency Diagram

Paste the Mermaid code below into [mermaid.live](https://mermaid.live) or any Mermaid-compatible renderer.

## Package Dependency Graph

```mermaid
graph BT
  subgraph Foundation["Foundation (no internal deps)"]
    schemas["@aflow/schemas<br/>─────────────────<br/>Zod schemas, operation registry,<br/>catalog, branded types"]
    lib["@aflow/lib<br/>─────────────────<br/>Shared utilities"]
    obs["@aflow/observability<br/>─────────────────<br/>OpenTelemetry, structured logging"]
    ds["@aflow/design-system<br/>─────────────────<br/>Design tokens, UI primitives,<br/>semantic components"]
  end

  subgraph Core["Core Packages"]
    db["@aflow/database<br/>─────────────────<br/>Drizzle ORM, migrations,<br/>tenant schema mgmt"]
    redis["@aflow/redis<br/>─────────────────<br/>Redis Streams, hot state,<br/>timers, heartbeats"]
    ps["@aflow/payload-store<br/>─────────────────<br/>PayloadStore abstraction<br/>(inline / Redis / GCS)"]
    ir["@aflow/input-resolution<br/>─────────────────<br/>Input resolution,<br/>expression evaluation"]
    authz["@aflow/authz<br/>─────────────────<br/>RBAC, OpenFGA,<br/>permission checks"]
  end

  subgraph Higher["Higher-Level Packages"]
    ai["@aflow/ai-client<br/>─────────────────<br/>Multi-provider AI client<br/>(OpenAI, Anthropic, Google, OpenRouter)"]
    er["@aflow/executor-runtime<br/>─────────────────<br/>Base ExecutorRuntime,<br/>StepHandler, concurrency"]
  end

  %% Foundation → Core
  db --> schemas
  redis --> schemas
  ps --> schemas
  ir --> schemas
  authz --> schemas

  %% Core → Higher
  ai --> ps
  ai --> schemas
  er --> ir
  er --> ps
  er --> redis
  er --> schemas

  %% Styling
  classDef foundation fill:#e8f5e9,stroke:#4CAF50,stroke-width:2px
  classDef core fill:#e3f2fd,stroke:#1976D2,stroke-width:2px
  classDef higher fill:#f3e5f5,stroke:#7B1FA2,stroke-width:2px

  class schemas,lib,obs,ds foundation
  class db,redis,ps,ir,authz core
  class ai,er higher
```

## Apps and Their Dependencies

```mermaid
graph BT
  subgraph Packages["Packages"]
    schemas["schemas"]
    db["database"]
    redis["redis"]
    ps["payload-store"]
    ai["ai-client"]
    er["executor-runtime"]
    ir["input-resolution"]
    obs["observability"]
    lib["lib"]
    ds["design-system"]
  end

  subgraph Apps["Applications"]
    server["Server<br/>(Fastify API)<br/>port 3000"]
    orch["Orchestrator<br/>(FlowExecutionService)"]
    execAI["Executor: AI<br/>(generate, agent_turn,<br/>embed, image)"]
    execAPI["Executor: API<br/>(HTTP calls)"]
    execUser["Executor: User<br/>(input / approval)"]
    execMem["Executor: Memory<br/>(CRUD, vectors)"]
    execMock["Executor: Mock<br/>(dev only)"]
    web["Web App<br/>(Next.js 15)<br/>port 3001"]
    mcp["MCP Server<br/>(external agents)"]
  end

  %% Server deps
  server --> db
  server --> lib
  server --> obs
  server --> ps
  server --> redis
  server --> schemas

  %% Orchestrator deps
  orch --> db
  orch --> obs
  orch --> ps
  orch --> redis
  orch --> schemas

  %% Executor deps (common)
  execAI --> er
  execAI --> ai
  execAI --> lib
  execAI --> ps
  execAI --> redis
  execAI --> schemas

  execAPI --> er
  execAPI --> db
  execAPI --> lib
  execAPI --> ps
  execAPI --> redis
  execAPI --> schemas

  execUser --> er
  execUser --> lib
  execUser --> ps
  execUser --> redis
  execUser --> schemas

  execMem --> er
  execMem --> ai
  execMem --> db
  execMem --> lib
  execMem --> ps
  execMem --> redis
  execMem --> schemas

  execMock --> er
  execMock --> lib
  execMock --> ps
  execMock --> redis
  execMock --> schemas

  %% Web deps
  web --> ds
  web --> schemas

  %% MCP (no internal deps)

  %% Styling
  classDef app fill:#fff3e0,stroke:#FF9800,stroke-width:2px
  classDef pkg fill:#e3f2fd,stroke:#1976D2,stroke-width:2px

  class server,orch,execAI,execAPI,execUser,execMem,execMock,web,mcp app
  class schemas,db,redis,ps,ai,er,ir,obs,lib,ds pkg
```

## Service Communication Map

```mermaid
graph LR
  subgraph External["External"]
    Client["Client / Web UI"]
    AIProviders["AI Providers<br/>(OpenAI, Anthropic,<br/>Google, OpenRouter)"]
    ExtAPIs["External APIs"]
  end

  subgraph Services["Phoenix Services"]
    Server["API Server"]
    Orch["Orchestrator"]
    ExAI["AI Executor"]
    ExAPI["API Executor"]
    ExUser["User Executor"]
    ExMem["Memory Executor"]
  end

  subgraph Infra["Infrastructure"]
    Redis["Redis"]
    PG["PostgreSQL"]
    GCS["GCS"]
  end

  Client <-->|"HTTP/SSE/WS"| Server
  Server <-->|"Streams"| Redis
  Server <-->|"Queries"| PG

  Orch <-->|"Streams +<br/>Hot State"| Redis
  Orch -->|"Flow defs"| PG
  Orch -->|"Flush runs"| PG

  ExAI <-->|"Job/Result<br/>Streams"| Redis
  ExAPI <-->|"Job/Result<br/>Streams"| Redis
  ExUser <-->|"Job/Result<br/>Streams"| Redis
  ExMem <-->|"Job/Result<br/>Streams"| Redis

  ExAI -->|"LLM calls"| AIProviders
  ExAPI -->|"HTTP calls"| ExtAPIs
  ExMem -->|"Queries"| PG

  ExAI --> GCS
  ExAPI --> GCS
  Orch --> GCS

  %% Styling
  classDef external fill:#e8f4f8,stroke:#2196F3,stroke-width:2px
  classDef service fill:#fff3e0,stroke:#FF9800,stroke-width:2px
  classDef infra fill:#ffebee,stroke:#f44336,stroke-width:2px

  class Client,AIProviders,ExtAPIs external
  class Server,Orch,ExAI,ExAPI,ExUser,ExMem service
  class Redis,PG,GCS infra
```
