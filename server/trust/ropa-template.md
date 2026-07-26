# ScopeCash AI — Record of Processing Activities (Art. 30 GDPR)

> Template Record of Processing Activities ("RoPA") for ScopeCash AI
> as **controller** for its own corporate processing. Customers should
> maintain their own RoPA covering their use of the Service as controller
> and may rely on this document and the DPA when entering ScopeCash AI
> in their own sub-processor inventory.
>
> Drafted to satisfy GDPR Article 30(1) for controllers and Article 30(2)
> for processors. Maintain in machine-readable form (this is the source of
> truth; the trust portal serves it as Markdown for procurement teams).

**Controller of record:** ScopeCash AI
**Joint controllers:** None.
**Last updated:** April 2026.

---

## A. Controller-role processing (Art. 30(1))

### A.1 Account and access management

| Field                                  | Value                                                              |
|----------------------------------------|--------------------------------------------------------------------|
| Purpose                                | Provide and administer accounts; authenticate users; enforce MFA.  |
| Categories of data subjects            | Customer Authorised Users; prospective users (sign-up flow).       |
| Categories of personal data            | Name, work email, hashed password, MFA secret, role, IP address.   |
| Categories of recipients               | Internal engineering and support; hosting sub-processor.           |
| International transfers                | None outside EU; backups remain in EU region.                      |
| Retention                              | Until account deletion + 30 days for backup recall.                |
| Legal basis (Art. 6)                   | Performance of contract (Art. 6(1)(b)).                            |
| Technical & organisational measures    | TLS 1.3, AES-256 at rest, MFA-enforced admin, RBAC, audit logging. |

### A.2 Billing and accounting

| Field                                  | Value                                                              |
|----------------------------------------|--------------------------------------------------------------------|
| Purpose                                | Invoice issuance, payment processing, statutory accounting records.|
| Categories of data subjects            | Customer billing contacts.                                         |
| Categories of personal data            | Billing email, organisation, VAT ID, invoice metadata.             |
| Categories of recipients               | Stripe (payment processor); accountants (under NDA); tax authority.|
| International transfers                | Stripe — SCCs (Decision (EU) 2021/914, Module 2) where applicable. |
| Retention                              | 10 years (statutory).                                              |
| Legal basis (Art. 6)                   | Legal obligation (Art. 6(1)(c)); contract (Art. 6(1)(b)).          |
| Technical & organisational measures    | Encrypted at rest, scoped admin access, immutable invoice ledger.  |

### A.3 Customer support

| Field                                  | Value                                                              |
|----------------------------------------|--------------------------------------------------------------------|
| Purpose                                | Respond to support requests; troubleshoot incidents.               |
| Categories of data subjects            | Customer Authorised Users who contact support.                     |
| Categories of personal data            | Name, email, message content, screenshots, optional attachments.   |
| Categories of recipients               | Support engineering; ticketing sub-processor (EU-hosted).          |
| International transfers                | None.                                                              |
| Retention                              | 24 months from ticket closure, then aggregated metrics only.       |
| Legal basis (Art. 6)                   | Performance of contract (Art. 6(1)(b)).                            |
| Technical & organisational measures    | RBAC, PII redaction in error logs, MFA-enforced access.            |

### A.4 Service security and abuse prevention

| Field                                  | Value                                                              |
|----------------------------------------|--------------------------------------------------------------------|
| Purpose                                | Detect and mitigate fraud, abuse, brute-force, denial-of-service.  |
| Categories of data subjects            | All visitors and users (anonymous and authenticated).              |
| Categories of personal data            | IP address, user agent, request metadata, rate-limit counters.     |
| Categories of recipients               | Internal security; WAF / hosting provider.                         |
| International transfers                | None.                                                              |
| Retention                              | 90 days rolling for raw logs; aggregated metrics indefinitely.     |
| Legal basis (Art. 6)                   | Legitimate interests (Art. 6(1)(f)) — security of network/services.|
| Technical & organisational measures    | Hash-chained audit log, WORM storage, alerting on anomalies.       |

### A.5 Product analytics

| Field                                  | Value                                                              |
|----------------------------------------|--------------------------------------------------------------------|
| Purpose                                | Aggregate feature usage to prioritise improvements.                |
| Categories of data subjects            | Authorised Users who have not opted out via cookie banner.         |
| Categories of personal data            | Pseudonymous user id, page views, feature interactions.            |
| Categories of recipients               | Internal product team; first-party analytics (no third-party).     |
| International transfers                | None.                                                              |
| Retention                              | 13 months, then aggregated.                                        |
| Legal basis (Art. 6)                   | Consent (Art. 6(1)(a)) via cookie banner; withdrawable at any time.|
| Technical & organisational measures    | Pseudonymisation; IP truncation; consent-gated SDK loading.        |

### A.6 Marketing communications (opt-in)

| Field                                  | Value                                                              |
|----------------------------------------|--------------------------------------------------------------------|
| Purpose                                | Send product updates, newsletters, event invites to opt-in list.   |
| Categories of data subjects            | Subscribers who provided consent.                                  |
| Categories of personal data            | Email address, name, engagement metrics.                           |
| Categories of recipients               | Email service (Resend; EU region).                                 |
| International transfers                | None.                                                              |
| Retention                              | Until unsubscribe + 30 days suppression-list retention.            |
| Legal basis (Art. 6)                   | Consent (Art. 6(1)(a)).                                            |
| Technical & organisational measures    | One-click unsubscribe; engagement metrics pseudonymised.           |

### A.7 Recruitment

| Field                                  | Value                                                              |
|----------------------------------------|--------------------------------------------------------------------|
| Purpose                                | Evaluate candidates; manage hiring pipeline.                       |
| Categories of data subjects            | Job applicants.                                                    |
| Categories of personal data            | Name, contact, CV, cover letter, interview notes.                  |
| Categories of recipients               | Internal hiring committee; ATS sub-processor (EU).                 |
| International transfers                | None.                                                              |
| Retention                              | 12 months from final decision; longer with consent (talent pool).  |
| Legal basis (Art. 6)                   | Pre-contractual measures (Art. 6(1)(b)); consent for talent pool.  |
| Technical & organisational measures    | RBAC, SSO, structured deletion workflow.                           |

---

## B. Processor-role processing (Art. 30(2))

For Customer Personal Data processed under the DPA at
`/trust/documents/dpa-template.md`, ScopeCash AI acts as a **Processor**
on behalf of each Customer (Controller).

| Field                                  | Value                                                              |
|----------------------------------------|--------------------------------------------------------------------|
| Categories of processing               | Storage, organisation, retrieval, classification, generation of    |
|                                        | technical documentation (Annex IV), evaluation, audit logging,     |
|                                        | export, erasure on instruction.                                    |
| Categories of data subjects            | As determined by the Controller (typically end-users of            |
|                                        | the Controller's AI systems and the Controller's employees).       |
| Categories of personal data            | As uploaded by the Controller; may include any category permitted  |
|                                        | by the Controller's processing instructions and the DPA.           |
| Sub-processors                         | See `/trust/documents/subprocessors.json`.                         |
| International transfers                | None for Customer Content (EU residency); SCCs for any out-of-EU   |
|                                        | sub-processor metadata, where unavoidable.                         |
| Retention                              | Per Controller's configured retention policy; default 30 days post-|
|                                        | account-termination for backup recall.                             |
| Technical & organisational measures    | Per Schedule of TOMs in the DPA; tested via SOC 2 controls.        |

---

## C. Special categories of personal data (Art. 9)

ScopeCash AI does **not** intentionally process special categories of
personal data (Art. 9 GDPR) in any controller-role activity above. Customers
are contractually required not to upload special-category data under the DPA
unless a separate written agreement is in place.

## D. Children's data (Art. 8)

The Service is not directed at, and ScopeCash AI does not knowingly
collect personal data from, individuals under 16. Suspected processing of
children's data triggers immediate deletion under the incident-response
procedure.

## E. Automated decision-making (Art. 22)

ScopeCash AI's controller-role processing does not include automated
decision-making producing legal or similarly significant effects on data
subjects within the meaning of Art. 22.

The Service performs automated **classification** of AI use cases on behalf
of Customers (processor role); the legal evaluation of those classifications
is reviewed by the Customer's qualified personnel before any deployment
decision.

## F. Data Protection Impact Assessment (Art. 35) trigger log

A DPIA is required where processing is "likely to result in a high risk".
ScopeCash AI's DPIA register lists each assessment with its scope,
conclusion, and review date. Trigger reviews are scheduled annually or on
material change, whichever is sooner.

| Trigger                                                | DPIA required? | Status                  |
|--------------------------------------------------------|----------------|-------------------------|
| Launch of any controller-role processing above         | Reviewed       | Documented in registry. |
| Introduction of new sub-processor handling PII         | Reviewed       | Per change-mgmt SOP.    |
| Material change to AI use-case classifier behaviour    | Reviewed       | Linked from changelog.  |
| Onboarding of customer with special-category data      | **Yes**        | Bespoke DPIA per deal.  |

---

## G. Contact

Privacy enquiries and DSR requests: `privacy@scopecash-ai.app`.
Security incidents: `security@scopecash-ai.app`.

*This RoPA was generated by the platform-generator. Review at least annually
and on any material change to processing operations, sub-processors, or the
legal landscape.*

