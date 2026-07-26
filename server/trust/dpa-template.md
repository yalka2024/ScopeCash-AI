# ScopeCash AI — Data Processing Addendum (Template)

> DRAFT — not yet reviewed by counsel. Bracketed placeholders must be filled
> in, and this document must be reviewed by an attorney before it is relied
> on. Standard DPA template offered to all paid customers. Custom DPAs
> available on Enterprise plans. This template constitutes a binding
> agreement when countersigned via the procurement workflow.

## 1. Roles
The Customer is the party that determines the purposes and means of processing personal information collected through its use of the Service. [LEGAL ENTITY NAME] ("Provider") processes personal information on Customer's behalf and at Customer's instruction as a service provider / processor.

## 2. Subject Matter & Duration
The subject matter is the provision of the ScopeCash AI Service. Processing continues for the duration of the Master Services Agreement and any post-termination retention period.

## 3. Nature & Purpose of Processing
Provider processes Customer Personal Data only as necessary to (a) deliver the Service, including AI-assisted analysis of Customer Content, (b) perform contractually required support, and (c) comply with applicable law.

## 4. Categories of Data Subjects
Customer's end-customers, employees, subcontractors, and any other individuals whose personal data (including images, voices, or location data captured in jobsite evidence) Customer chooses to process via the Service.

## 5. Categories of Personal Data
Identification data (name, email), authentication data, content uploaded by Customer (contracts, estimates, photos, audio recordings, messages), telemetry, and any optional fields configured by Customer. Uploaded evidence may incidentally include images or voice recordings of identifiable individuals and, in some jurisdictions, may constitute biometric identifiers.

## 6. Sub-processors
Provider's authorised sub-processors are listed at `/trust/documents/subprocessors.json`, and currently include Google Cloud Platform (hosting, storage, and AI processing via Vertex AI/Gemini), a transactional email provider, Stripe (payments), and Sentry (error monitoring). Provider will give the Customer at least 30 days' advance notice of any new sub-processor that will process Customer Content; the Customer may object on reasonable grounds.

## 7. Security Measures
Provider implements the technical and organisational measures described at `/trust/documents/security-overview.md` and aligned to the controls in `/trust/documents/security-controls.json`.

## 8. Data Subject Rights
Provider will assist the Customer in responding to requests from individuals to access, correct, or delete their personal data, via the in-product self-service tools and the `/api/privacy/dsr` endpoints. Where assistance is required beyond automated facilities, Provider will respond within 10 business days.

## 9. Security Incident Notification
Provider will notify the Customer without unreasonable delay after confirming a security incident involving Customer Personal Data, consistent with applicable state breach-notification law, and will provide the information reasonably available at the time of notification.

## 10. Audits
Provider will respond to reasonable security questionnaires once per 12-month period at no cost, and will make available a summary of its security posture on request. On-site audits are subject to scheduling and confidentiality requirements.

## 11. Return / Deletion
On termination, Provider will, at the Customer's option, return or delete all Customer Personal Data within 30 days, subject to retention required by law, any active legal hold, and backups, which are deleted on a rolling cycle described in the security overview.

## 12. International Transfers
[If Customer or its data subjects are located outside the United States, describe the applicable transfer mechanism here — e.g. Standard Contractual Clauses — and consult counsel. Not pre-filled: this depends on where the business is actually operating and who its customers are.]

---
*This template is a starting point, not a substitute for legal advice. Fill in the bracketed placeholders and have it reviewed by counsel before relying on it for real customer data.*
