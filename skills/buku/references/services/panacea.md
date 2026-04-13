# Panacea

BukuWarung's internal web portal for managing merchant and user information, payment operations, and administrative tasks.

## GitHub Repository

https://github.com/bukuwarung/panacea

## Description

Panacea is the internal dashboard/portal for BukuWarung operations teams. It provides comprehensive tools for managing users, merchants, transactions, KYC verification, and various payment operations. The application serves as the primary interface for internal staff to perform administrative tasks.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript |
| Framework | Next.js 12 |
| UI Library | React 17, Ant Design 5, Material UI 5, TailwindCSS 3 |
| State Management | Redux Toolkit, Zustand, React Query |
| Build Tool | Yarn |
| Testing | Jest, React Testing Library |
| Monitoring | Datadog RUM, Sentry |
| Node Version | 20+ |

## Project Structure

```
panacea/
├── src/
│   ├── components/     # Reusable UI components
│   ├── constants/      # Application constants
│   ├── context/        # React context providers
│   ├── hooks/          # Custom React hooks
│   ├── layouts/        # Page layouts
│   ├── libs/           # Utility libraries
│   ├── modules/        # Feature modules
│   ├── pages/          # Next.js pages (routes)
│   ├── server/         # Server-side logic
│   ├── services/       # API service clients
│   ├── slickApproval/  # Approval workflow module
│   ├── store/          # Redux store configuration
│   ├── styles/         # Global styles
│   ├── types/          # TypeScript type definitions
│   └── utils/          # Utility functions
├── public/             # Static assets
├── services/           # Backend service integrations
└── docs/               # Documentation
```

## Key Features / Responsibilities

- **User/Merchant Management**: View and manage user profiles, merchant details
- **Transaction Management**: Monitor and manage payment transactions
- **KYC/KYB Verification**: Review and approve KYC submissions
- **Payment Operations**: Disbursements, refunds, virtual account management
- **Bulk Operations**: Async bulk operation support for large-scale tasks
- **Reporting**: Transaction reports, analytics dashboards
- **Role-based Access Control**: Permission management for internal users
- **AI-assisted Operations**: LangFlow chat integration for operational support

## API Routes (via app-gateway)

| Route Pattern | Description |
|---------------|-------------|
| `/panacea/**` | All Panacea portal routes |

## Dependencies / Integrations

### Backend Services
- **golden-gate**: Payment portal backend API
- **multi-tenant-auth**: Authentication and authorization
- **payments**: Payment processing APIs
- **accounting-service**: Transaction and business data
- **janus**: KYC verification data
- **notification**: Sending notifications to users

### External Services
- **Datadog**: Application performance monitoring
- **Sentry**: Error tracking and monitoring
- **AWS S3**: File storage for uploads
- **Google BigQuery**: Analytics data queries
- **Google Maps API**: Location services
- **Mixpanel**: Product analytics

## Local Development

```bash
# Install dependencies
yarn install

# Add environment file
# Create .env/.env.local with required variables

# Start development server
yarn dev
# or
yarn local
```

### Environment Variables

```bash
NEXT_PUBLIC_ENVIRONMENT=local
PRODUCTION=false
NEXT_PUBLIC_BASE_URL="https://api-dev.bukuwarung.com"
NEXT_PUBLIC_OAUTH2_REDIRECT_HOST_URL=http://localhost:3000
```

## Testing

```bash
# Run tests
yarn test

# Run tests with coverage
yarn coverage
```

## Build

```bash
# Development build
yarn build:dev

# Staging build
yarn build:staging

# Production build
yarn build:prod
```
