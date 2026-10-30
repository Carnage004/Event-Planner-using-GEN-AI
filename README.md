# Jashn

A celebratory event planner with Firebase Authentication, Cloud Firestore, and a Node.js API for planning assistance.

## Run locally

1. Install Node.js 22.5 or newer.
2. Create a Firebase project and register a Web app.
3. In Firebase Authentication, enable Email/Password and Google sign-in. Add 127.0.0.1 to the authorized domains if it is not already listed.
4. Create the default Cloud Firestore database.
5. Copy .env.example to .env. It already contains this Jashn Firebase Web app config; add your private service-account JSON path and keep that key file outside this project.
6. Set GOOGLE_APPLICATION_CREDENTIALS to the path of a private Firebase service-account JSON file. Give the service account only the Firebase Authentication and Firestore roles the server needs. Keep the file outside this project and never commit or share it.
7. Install dependencies and start the server:

    npm install
    npm start

8. Open http://127.0.0.1:3000.

The client uses the Firebase JavaScript SDK 13.1.0. The Node backend verifies Firebase ID tokens with the Firebase Admin SDK. Event plans are stored under users/{uid}/plans in Cloud Firestore; profile data is stored under users/{uid}. The server verifies the signed-in user and scopes every plan request to that UID. Users add and manage their own event vendors (contact details, service, estimated cost, notes, and booking status); those entries are stored inside the event plan in Firestore. Jashn does not present fictional vendor profiles as real businesses. Deploy firestore.rules before using Firestore directly from client code; the Admin SDK server calls use IAM and perform their own user/ownership checks.

The .env file and service-account JSON are private local configuration and are excluded from the project ZIP. The existing SQLite prototype data is not migrated automatically. Existing local accounts will need to create Firebase accounts; old plans remain in the local data folder until you choose to migrate them.

## Optional AI planning

Set GEMINI_API_KEY in .env to enable live Gemini responses for /api/ideas and /api/chat. The default model is gemini-3.5-flash-lite; set GEMINI_MODEL to choose another Gemini model available to your key. Gemini is used first when both provider keys exist. As an optional alternative, set OPENAI_API_KEY and OPENAI_MODEL. With neither key, built-in guided responses are used. Keep provider keys in the server .env only; they are never sent to the browser. Free-tier quota and model availability depend on Google AI Studio account limits.

## Firebase setup files

- .env.example — Firebase web settings and server credential path template
- firebase.json and firestore.rules — Firestore rules configuration
- server-handler.mjs — Firebase token verification, profile and plan APIs, Gemini/OpenAI planning endpoints, and web push device registration; local.mjs starts it for `npm start`
- functions/index.js — scheduled sender for saved timeline reminders
- manifest.webmanifest — installable web app metadata
- planner.html — Jashn interface, Firebase Authentication flows, and user-managed vendor lists

## API

- GET /api/config/firebase — public Web SDK config and setup status
- GET /api/health — server configuration status
- Email/password and Google registration, sign-in, and sign-out are handled by Firebase Authentication in the client SDK
- GET /api/me — verify current Firebase user
- PUT /api/profile — update profile
- GET /api/plans — list the signed-in user's plans
- POST /api/plans — save a plan
- PUT /api/plans/:id — update a plan
- DELETE /api/plans/:id — delete a plan
- POST /api/ideas — planning ideas
- POST /api/chat — signed-in planning assistant
- GET /api/notifications/status — current device notification registration status
- POST /api/notifications/device — register this device for push
- DELETE /api/notifications/device — disable push on this device

## Event-day phone reminders

The Settings page can request browser notification permission and register the current browser/device with Firebase Cloud Messaging. Each saved event's unfinished timeline items send a push at the item's start time, using the timezone of the device that saved the plan. Marking a timeline item done prevents its reminder. Device registrations are stored under `users/{uid}/devices`; send receipts are stored under `users/{uid}/notificationReceipts` to avoid repeats.

FCM web push requires a secure HTTPS origin (localhost/127.0.0.1 can be used for local development; a phone cannot use the computer's localhost URL). For iPhone/iPad, users must install the HTTPS site to the Home Screen and use iOS/iPadOS 16.4 or newer before granting notification permission. The service worker is served from the site root at `/firebase-messaging-sw.js`.

### Deploy for real phone delivery

Local `npm start` is only for development. To deliver reminders when the app is closed, both the Node API and the scheduled sender must be deployed:

1. Add `FIREBASE_VAPID_KEY` from Firebase Project settings > Cloud Messaging > Web configuration > Web Push certificates to the production environment. It is a public key; never deploy the service-account JSON key.
2. Deploy the Node app to an HTTPS service such as Cloud Run in `asia-south1`. Cloud Run uses its attached service identity (ADC); grant it the Firebase Authentication and Firestore permissions used by the server. Set the Firebase web config and `FIREBASE_VAPID_KEY` as runtime environment variables. The project needs billing enabled for Cloud Run.
3. Add the deployed `run.app` host (without `https://` or path) to Firebase Authentication's Authorized domains.
4. Install the Firebase CLI if needed, then in the project root sign in and deploy the scheduled function:

       npm install -g firebase-tools
       firebase login
       firebase use jashn-event-planner
       firebase deploy --only functions

   Scheduled Cloud Functions require the Blaze plan and Cloud Scheduler. The function checks saved plans every minute; usage can incur charges. Set billing alerts before deploying.
5. Open the deployed HTTPS URL on the phone, sign in, go to Settings, and choose **Enable notifications**. Accept the browser permission prompt. Save plans with a date and timeline to receive reminders.

The VAPID public key is included in `.env.example`. The private service-account JSON and local `.env` are not included in the ZIP. Push delivery is not active until deployment and device opt-in are complete.
## Vercel deployment

This project includes `api/[...path].mjs` as a Vercel catch-all API route and rewrites `/` to `planner.html`. Import the repository into Vercel using the repository root. Leave the Build Command and Output Directory at their defaults.

Add these environment variables in Vercel Project Settings for Production (and Preview if needed): `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID`, and `FIREBASE_SERVICE_ACCOUNT_JSON`. The last variable must contain the complete contents of your replacement Firebase service-account JSON key and must be treated as a secret. Add `GEMINI_API_KEY` to enable the Gemini assistant. Do not set `GOOGLE_APPLICATION_CREDENTIALS` to a local Windows path on Vercel.

After deployment, add the Vercel domain under Firebase Console > Authentication > Settings > Authorized domains. Redeploy after changing environment variables. Never commit `.env` or a service-account key.
