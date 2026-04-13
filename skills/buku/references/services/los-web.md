# LOS Web

Loan Origination System Web frontend - user interface for loan management and origination workflows.

## Repository

- **GitHub**: https://github.com/bukuwarung/los-web

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript |
| Framework | Next.js 11 |
| UI Library | React 17 |
| CSS | SASS, Bootstrap 5 |
| UI Components | Ant Design 4.16 |
| State Management | SWR |
| HTTP Client | Axios |
| Analytics | Amplitude |

## Key Features / Responsibilities

- Loan application management dashboard
- Loan origination workflow UI
- Lender integration interface
- Application status tracking
- User authentication and authorization
- Report generation and export

## Project Structure

```
los-web/
|-- src/
|   |-- pages/         # Next.js pages and API routes
|   |-- components/    # React components
|   |-- styles/        # SASS stylesheets
|-- public/            # Static assets
|-- copilot/           # AWS Copilot configuration
```

## API Routes

All routes are prefixed with `/los-web/`:

| Route Pattern | Description |
|---------------|-------------|
| `/los-web/**` | LOS Web frontend static assets and pages |

Note: This is a frontend application. API calls are made to the LOS Lender backend service.

## Dependencies / Integrations

### Internal Services
- **LOS Lender**: Backend API for loan processing
- **Authentication Service**: User authentication

### External Dependencies
- **Amplitude**: User analytics and tracking

### Key Libraries
- **Next.js**: React framework with SSR
- **Ant Design**: UI component library
- **SWR**: Data fetching and caching
- **Axios**: HTTP client
- **Moment.js**: Date manipulation
- **Lodash**: Utility functions
- **NProgress**: Page loading indicator
- **React Input Mask**: Form input formatting
- **React Icons**: Icon library

## Development

### Prerequisites
- Node.js
- Yarn

### Build & Run
```bash
# Install dependencies
yarn install

# Run development server
yarn dev

# Build for production
yarn build

# Start production server
yarn start
```

### Code Quality
```bash
# Run linting
yarn lint

# Prepare git hooks
yarn prepare
```

### Pre-commit Hooks
Husky and lint-staged are configured for:
- ESLint checking
- Prettier formatting

## Configuration

Environment files:
- `.env.development` - Development environment
- `.env.production` - Production environment

## Development Guidelines

### ESLint Configuration
- TypeScript support via `@typescript-eslint`
- React and React Hooks plugins
- Prettier integration
- SonarJS for code quality
- Import sorting automation

### TypeScript
- Strict type checking enabled
- Type definitions for all major dependencies

### Styling
- SASS for custom styles
- Bootstrap 5 for layout
- Ant Design for components

## Deployment

Built as a Docker container using the provided `Dockerfile`:
- Uses multi-stage build
- Optimized for production
- AWS Copilot configurations in `copilot/` directory

### URLs
- Development: `http://localhost:3000`
- API routes: `/api/*` (Next.js API routes)
