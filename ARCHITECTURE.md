# Architecture

## Trust boundary

The Chrome extension is a user interface. It is not a secret store and does not call Flipkart with an app secret.

## Data flow

1. Extension creates a local device session with the backend.
2. User starts Flipkart OAuth.
3. Backend creates the `state`, receives the callback, exchanges the authorization code and encrypts access/refresh tokens.
4. User uploads a source document.
5. Backend extracts text.
6. Ollama receives only the extracted document section and returns JSON constrained by a strict schema.
7. The backend runs deterministic validation.
8. User reviews and can edit the record.
9. Saving a record clears approval and re-runs validation.
10. User explicitly selects products to approve.
11. Publish endpoint verifies approval and validation again.
12. Approved products are batched in groups of 10 and posted to Flipkart.
13. Per-SKU results are stored; failures never silently become success.
14. A transient HTTP failure is retried with backoff; 401 causes one token refresh/retry.

## Fail-closed rules

- Missing FSN/product_id blocks publication.
- Missing seller SKU blocks publication.
- Missing HSN/tax code blocks publication.
- Missing location information blocks publication.
- Invalid Flipkart enum values block publication.
- Selling price above MRP blocks publication.
- Required package dimensions/weight inconsistencies block publication.
- Non-Indian country of origin without importer details blocks publication.
- No product can be submitted without explicit human approval.
