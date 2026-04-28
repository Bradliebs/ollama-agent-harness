# 💻 Code Apps — Build Power Apps with React & TypeScript

> **What this does:** Walks you through creating a Power App using React and
> TypeScript code instead of the traditional low-code canvas editor.
>
> **When to use this:** When you want the full power of a code IDE (VS Code)
> combined with Power Platform's data connectors and enterprise features.
>
> **Prerequisites:**
> - Node.js LTS (18+)
> - [Power Platform CLI](https://learn.microsoft.com/power-platform/developer/cli/introduction) (`pac`)
> - Power Platform environment with [code apps enabled](https://learn.microsoft.com/power-apps/developer/code-apps/overview#enable-code-apps-on-a-power-platform-environment)
> - A Microsoft work or school account

---

## Step 1 — Scaffold Your App

Open a terminal and run:

```bash
npx degit github:microsoft/PowerAppsCodeApps/templates/vite my-app
cd my-app
```

This creates a Vite-based React/TypeScript project pre-configured for Power Apps.

## Step 2 — Authenticate with Power Platform

```bash
pac auth create
```

Sign in with your Power Platform account when prompted. This connects your local tools to your cloud environment.

Then select your target environment:

```bash
pac env select --environment <your-environment-id>
```

> **How to find your environment ID:** Go to [Power Platform admin center](https://admin.powerplatform.microsoft.com), click your environment, and copy the ID from the URL.

## Step 3 — Install and Initialize

```bash
npm install
pac code init --displayname "My First Code App"
```

This:
- Installs the `@microsoft/power-apps` client library
- Creates a `power.config.json` file linking your app to Power Platform
- Sets up the connection between your code and the platform

## Step 4 — Run Locally

```bash
npm run dev
```

Open the **Local Play** URL shown in the terminal. Use the same browser profile as your Power Platform account.

> ⚠️ **Browser note:** Chrome and Edge may block localhost connections. If you see an error, grant permission for local network access in your browser settings.

## Step 5 — Build and Publish

When you're ready to deploy:

```bash
npm run build | pac code push
```

This compiles your React app and publishes it to Power Platform. You'll get a Power Apps URL to share with users.

## Step 6 — Connect to Data (Optional)

Code Apps can use Power Platform connectors for data. To add a connector:

```bash
pac code add-connection --connector <connector-name>
```

This generates TypeScript models and services in your project that you import and use like any other TypeScript module.

---

## Architecture Overview

```
Your React/TypeScript Code
        ↓
Power Apps Client Library (@microsoft/power-apps)
        ↓
Power Platform Connectors (SharePoint, Dataverse, SQL, etc.)
        ↓
Data Sources
```

The `power.config.json` file manages metadata. The client library handles authentication, connector access, and hosting integration. Your code stays as standard React/TypeScript.

## Tips

- **Start with the Vite template** — it has everything pre-configured.
- **Use `npm run dev` frequently** — hot reload works, so you see changes instantly.
- **Connectors give you enterprise data** — SharePoint lists, Dataverse tables, SQL databases, and 1000+ other sources, all with built-in auth.

## Learn More

- [Create a code app from scratch](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/create-an-app-from-scratch)
- [Code apps architecture](https://learn.microsoft.com/power-apps/developer/code-apps/architecture)
- [System limits and configuration](https://learn.microsoft.com/power-apps/developer/code-apps/system-limits-configuration)
- [Connect your code app to data](https://learn.microsoft.com/power-apps/developer/code-apps/how-to/connect-to-data)
