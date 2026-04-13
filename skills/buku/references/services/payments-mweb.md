# Payments Mobile Web (payments-mweb)

## Description

Payments Mobile Web is a Next.js-based frontend application that provides mobile web interfaces for payment-related flows. It serves as the mobile-optimized web interface for BukuWarung's payment services, enabling users to complete payment transactions through their mobile browsers.

## GitHub Repository

https://github.com/bukuwarung/payments-mweb

## Tech Stack

- **Language**: TypeScript
- **Framework**: Next.js 10.x
- **UI Framework**: React 17, Material-UI, Tailwind CSS
- **Styling**: SASS, Styled Components
- **State Management**: React Query (TanStack)
- **Form Handling**: Formik, Yup
- **Analytics**: Amplitude
- **Error Tracking**: Sentry
- **HTTP Client**: Axios

## Key Features/Responsibilities

- Mobile-optimized payment flow interfaces
- Payment transaction processing UI
- QR code generation and display (qrcode.react)
- Barcode rendering for payment receipts
- PDF document viewing and generation
- Image compression for document uploads
- Video player integration for tutorials/guides
- Multi-environment support (dev, staging, production)

## API Routes

- **Base Path**: `/payments-mweb/**`
- Routes are handled through Next.js pages routing under `src/pages/`

## Project Structure

```
src/
  constants/     # Application constants
  containers/    # Container components
  context/       # React context providers
  hooks/         # Custom React hooks
  lib/           # Utility libraries
  pages/         # Next.js page routes
  sections/      # Page sections/layouts
  services/      # API service integrations
  styles/        # Global styles
  utils/         # Utility functions
components/      # Reusable UI components
public/          # Static assets
```

## Dependencies/Integrations

- **Backend Services**: Integrates with BukuWarung payment APIs via Axios
- **AWS SDK**: Used for cloud service integrations
- **Firebase Admin**: Backend authentication and services
- **Sentry**: Error monitoring and performance tracking
- **Amplitude**: User analytics and event tracking

## Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for specific environment
npm run build:dev
npm run build:staging
npm run build:prod

# Start production server
npm start
```

## Deployment

- Deployed via Jenkins CI/CD pipeline
- Containerized using Docker
- Deployed to AWS ECS using Copilot
