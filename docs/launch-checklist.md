# Launch checklist (for the Slotback team)

The software, demo and website are built. These are the business and account steps that only the owner can do. Several are promises the website already makes, so they must be true before the site is public.

## Make it findable

- [ ] **Rename the GitHub repository** to `slotback` (Settings → General → Repository name). GitHub redirects the old URL.
- [ ] **Turn on GitHub Pages:** Settings → Pages → Source: **GitHub Actions**. The `Deploy site` workflow publishes `site/` on every push to `main`.
- [ ] **Buy a domain** (for example a `.health` or `.com` name), add `site/CNAME` containing it, point DNS at GitHub Pages, and set the repository variable `SITE_URL` to `https://<domain>` so canonical URLs, the sitemap and social previews use it.
- [ ] Set repository variables `CONTACT_EMAIL` and `SECURITY_EMAIL` (otherwise the site shows `@example.com` placeholders).
- [ ] Verify the domain in **Google Search Console** and **Bing Webmaster Tools** and submit `https://<domain>/sitemap.xml`.
- [ ] List the product where practices look: Capterra / G2 / Software Advice (patient scheduling & waitlist categories), psychiatry and therapy practice forums, and EHR app marketplaces where available.

## Make the website's promises true

The pages state these as facts. Change the copy or make them true before launch:

- [ ] **Business Associate Agreement:** have a healthcare attorney prepare a BAA template and a subcontractor list (hosting, SMS, email, backups).
- [ ] **Hosted infrastructure:** a HIPAA-eligible cloud account under a BAA (for example AWS, Google Cloud or Azure), one instance and key per practice, encrypted backups, named staff access with MFA.
- [ ] **Twilio BAA** (or another SMS provider that signs one) for the hosted plan.
- [ ] **Pricing** ($0 / $49 / $39 per provider, 500 messages then $0.02, $750 interface setup, 30-day pilot, annual = 2 months free): confirm or edit in `site/pricing.html`, `site/index.html` (JSON-LD and teaser) and `site/assets/pricing.js`.
- [ ] **Support commitments** (1 business day, 4 business hours for Group, security report acknowledgement in 2 business days).
- [ ] **Policies:** a privacy policy and terms of service for the website and hosted service.
- [ ] **License:** choose how the self-hosted edition is licensed (for example AGPL-3.0 for open source with copyleft, or a source-available license) and add a `LICENSE` file. The pricing page calls self-hosting free; without a license, the code is all rights reserved by default.
- [ ] An internal **HIPAA risk analysis** and security policies for the company itself as a business associate.

## Before the first real patient

- [ ] Deploy a pilot instance with `docker compose` (see `README.md`), generate a fresh encryption key, and store it in a secrets manager.
- [ ] Walk the [go-live checklist](../site/implementation.html#checklist) with the pilot practice.
- [ ] Run `npm test` and `npm audit` on the exact commit you deploy.
