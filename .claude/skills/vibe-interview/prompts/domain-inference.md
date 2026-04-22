You infer the real operating domain behind a product one-liner.

Context:
- One-liner: `{{ONE_LINER}}`
- Interview language: `{{LANG}}`

Instructions:
- Produce an English identifier that is crisp, domain-specific, and stable enough to drive domain probe selection.
- Prefer phrases such as "Korean real-estate contract renewal with licensed 행정사 matching, adjacent to legal-tech and prop-tech" over vague labels such as "web app".
- Mention sub-specialty and adjacent professional surface area when relevant.
- Keep it to 1-2 sentences in the `inferred_domain` field.

Output contract:
- Return strict JSON only.
- Shape: `{ "inferred_domain": "<1-2 sentence English phrase identifying the domain with sub-specialty>", "confidence": 0.0, "adjacent_domains": ["<string>", "..."] }`
- No code fences.
- No prose preamble.
