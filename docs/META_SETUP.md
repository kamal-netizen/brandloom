# Meta (Instagram) setup — your checklist

Brandloom publishes through Meta's official **Instagram API with Facebook Login**.
That needs three things only you can do: the Instagram accounts set up the right
way, a Meta app, and pasting the app's secret into Shipyard. Nobody else (and no
assistant) needs your Facebook password or the app secret.

Takes about 30 minutes the first time. Do the steps in order.

---

## 1. Each Instagram account must be a professional account linked to a Facebook Page

Do this for all five: Core Champs, JNK Nutrition, Muscle Rulz, Scoops Monster, ProScience Nutra.

1. In the Instagram app: **Profile → ☰ → Settings and activity → Account type and tools**.
   If it offers *Switch to professional account*, switch to **Business** (Creator also works).
2. Link it to the brand's Facebook Page. Easiest from the Page side:
   **facebook.com → the Page → Settings → Linked accounts → Instagram → Connect account**,
   log in with that Instagram account.
3. Check: your own Facebook profile must have **full control** of each Page
   (Page → Settings → Page access, or the business portfolio below).

> Tip: if the five Pages live in one **business portfolio** (business.facebook.com → Settings → Pages /
> Instagram accounts), give yourself full control there. That makes step 5 one login for all brands.

## 2. Create the Meta app

1. Go to **https://developers.facebook.com/apps** → **Create app**.
2. Use case: **Other** → app type **Business** → name it **Brandloom**, contact email kamal@jnknutrition.com,
   and attach it to your **business portfolio** (JNK).
3. On the app dashboard, **Add product**:
   - **Facebook Login for Business** → Set up
   - **Instagram** → choose **"API setup with Facebook login"**

## 3. Facebook Login for Business settings

1. **Facebook Login for Business → Settings**
   - *Valid OAuth Redirect URIs* — add exactly:
     ```
     https://brandloom.srv1867587.hstgr.cloud/api/meta/callback
     ```
     (later, if Brandloom gets its own domain, add `https://<that domain>/api/meta/callback` too)
   - Keep *Use Strict Mode for redirect URIs* and *Enforce HTTPS* **on**.
   - Save.
2. **Facebook Login for Business → Configurations → Create configuration**
   - Name: `Brandloom publishing`
   - Login variation: **General**
   - Access token: **User access token**
   - Assets: **Pages** and **Instagram accounts**
   - Permissions — tick these six:
     `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `business_management`,
     and `pages_manage_posts` (Facebook Page posts and stories — needs the **Manage everything on your Page** use case
     added to the app first)
   - Create, then copy the **Configuration ID** (a long number).

## 4. App settings → Basic

| Field | Value |
|---|---|
| App domains | `brandloom.srv1867587.hstgr.cloud` |
| Privacy policy URL | `https://brandloom.srv1867587.hstgr.cloud/privacy` |
| User data deletion → Data deletion instructions URL | `https://brandloom.srv1867587.hstgr.cloud/data-deletion` |
| Category | Business and pages |

Save. Then note the **App ID** and click **Show** next to **App secret** (Facebook asks for your password — that stays between you and Facebook).

**Leave the app in Development mode.** You are the app's admin and the admin of the five Pages, so all
the permissions work for your own accounts without App Review or business verification. (Review is
only needed if people outside the app's roles ever connect accounts.) If a teammate will click
*Connect*, add them under **App roles → Roles** as Admin or Tester first.

## 5. Paste three values into Shipyard

Shipyard dashboard → project **brandloom** → **Environment variables**:

| Name | Value |
|---|---|
| `META_APP_ID` | the App ID |
| `META_APP_SECRET` | the App secret |
| `META_CONFIG_ID` | the Configuration ID from step 3 |

Then **Redeploy** (env changes apply on the next deploy). Brandloom → Settings → System should now say
*Meta app: configured · login config set*.

## 6. Connect each brand

Brandloom → **Brands → Core Champs → Connect Instagram**.

- Facebook opens. Continue as yourself, and when it asks which Pages and Instagram accounts to give
  Brandloom, you can select **all five** at once.
- Back in Brandloom, the right account is bound automatically when it matches the brand's handle,
  otherwise you pick it from the list.
- Repeat *Connect* for the other four brands (each is one click now — Facebook remembers the grant).

Each brand page then shows **Connected as @handle**.

---

## Accounts with no Facebook Page: Instagram login

Scoops Monster and ProScience only exist on Instagram. Facebook Login can only reach an Instagram
account through its Facebook Page, so for these Brandloom uses Meta's second official route,
**Instagram API with Instagram Login**, through the same Meta app's Instagram product.

1. App dashboard → **Use cases → Instagram API → API setup with Instagram login**.
   - Note the **Instagram app ID** (not secret) and the **Instagram app secret** (Show).
   - **Permissions and features**: add `instagram_business_basic` and `instagram_business_content_publish`.
   - **Set up Instagram business login → Business login settings → OAuth redirect URIs**:
     `https://brandloom.srv1867587.hstgr.cloud/api/meta/ig-callback`
2. While the app is in Development mode, each account must be an **Instagram Tester**:
   App roles → Roles → Instagram Testers → Add → the username; then in that Instagram account,
   **Settings → Website permissions → Apps and websites → Tester invites → Accept**.
3. Shipyard env vars: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` (runtime). Redeploy.
4. Brandloom → the brand → **Connect with Instagram** → log in to *that brand's* Instagram account
   (instagram.com remembers one login per browser — check the account name before you allow).

These tokens last 60 days; Brandloom renews them automatically while they are valid. If one lapses
the brand shows **Needs reconnect** and the fix is Connect with Instagram again.

---

## Later: when Brandloom asks you to "Reconnect"

Page tokens don't expire on a timer, but they stop working if you change your Facebook password,
lose admin on a Page, remove the app in Facebook settings, or after Meta's ~90-day data-access window.
Brandloom checks every connection daily, shows a red badge on **Brands** 14 days before data access
lapses, and a scheduled post for that brand fails with "needs reconnecting" rather than silently.
The fix is always the same: brand page → **Reconnect**.

## Troubleshooting

| Message | Fix |
|---|---|
| *None of the Pages you granted has an Instagram professional account linked* | Step 1.2 for that brand, then Connect again and make sure that Page is ticked. |
| *@x is already connected to another brand* | You picked the wrong account; Disconnect the other brand or pick again. |
| *Instagram rejected the media* | The image must be a JPEG Brandloom made (it always is) and reachable publicly; check Settings → System → Public media base is the https site address. |
| Login dialog says the app is not available | You're not an admin/tester of the app (step 4), or the app was switched to Live without review. |
