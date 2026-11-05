# Saving your work to your account

When this is switched on, each signed-in person's workspace (shots, projects, scripts, prompts, characters) is saved to their own account. It survives server restarts, and it opens on another phone or computer after signing in.

Without it, work is only kept in the browser it was made in. That is the default, and it keeps working either way.

## What you need

- A free Supabase project (you already have one).
- About five minutes. No coding, no secret keys, no payment.

## One-time setup

### 1. Create the table in Supabase

1. Open your project at supabase.com and choose **SQL Editor** in the left menu.
2. Choose **New query**.
3. Open the file `supabase/migrations/20261105150000_workspace_snapshots.sql` from this repository, copy everything in it, and paste it into the editor.
4. Press **Run**. It says "Success". It is safe to run more than once.

This creates one small table with a privacy rule: every signed-in person can only ever see and change their own row.

### 2. Tell the server where to save

In your hosting dashboard (for example Render, under **Environment**), set these three values:

| Name | Value |
| --- | --- |
| `AUTH_MODE` | `supabase` |
| `SUPABASE_URL` | Your project URL, for example `https://abcd1234.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | The **publishable** key (starts with `sb_publishable_`) |

Find both in Supabase under **Project Settings → API Keys**.

**Use only the publishable key.** Never paste a secret key or a `service_role` key anywhere in this app, in a chat, or in an issue. This feature does not need one. The publishable key is designed to be public; the privacy rule in step 1 is what protects each person's data.

### 3. Redeploy and check

1. Redeploy the site.
2. Sign in and make something, for example with **Quick start**.
3. Look at the top bar. After a few seconds it should say **☁ Saved to your account**.
4. Sign in on another device. A message says your saved work was restored.

## What people see

| Top bar says | Meaning |
| --- | --- |
| ☁ Saved to your account | Everything is saved. |
| ☁ Saving… / Changes not saved yet | A save is about to happen or in progress. |
| Saved on this device only | Not signed in. Work is still kept in this browser. |
| Offline · saved on this device | No connection. It saves again when the connection returns. |
| Cloud save not set up | Step 1 has not been done yet. |
| ⚠ Two versions of your work | The account was changed on another device. A box asks which version to keep. Choosing the account version can be undone. |

## Good to know

- **Nothing is overwritten silently.** Each save carries a version number. If another device saved first, the person is asked instead of losing work.
- **What is saved:** projects, tasks, shots, characters, series plans, prompts, scripts and the workflow steps. **Not saved:** uploaded media files, sign-in details and temporary screen state.
- **Size limit:** about 900 KB of text per person, far more than a normal storyboard. If a workspace is too large, the person is told to remove unused items.
- **Turn it off:** set `WORKSPACE_SYNC=off` and redeploy. Work stays in each browser as before.
- **Free tier limits:** Supabase's free plan pauses projects that are unused for a week. Opening the project in the dashboard wakes it.

## If something goes wrong

- *"Cloud save not set up"* — run step 1 again, then reload the page.
- *Chip never appears* — check `AUTH_MODE` is `supabase` and both Supabase values are set, then redeploy.
- *"Could not save · will retry"* — work is safe on the device. Check the Supabase project is not paused, then reload.
