# BDD — Behavior-Driven Development (GIVEN/WHEN/THEN)

## Purpose
Specify functional requirements with concrete, testable scenarios.

## Format
Every scenario follows three sections:

```
Scenario: <title>
  Given <precondition>
  When <action>
  Then <expected outcome>
```

## Example
```
Scenario: User logs in with valid credentials
  Given the user is on the login page
  When the user enters valid email and password
  Then the user is redirected to the dashboard
```

## Rules
1. **One behavior per scenario** — scenarios should be independent and order-independent
2. **Concrete examples, not abstractions**
   - ❌ "Given the system is configured"
   - ✅ "Given maxRetries is set to 3"
3. **Avoid implementation details**
   - ❌ "When the user clicks the submit button" (assumes UI)
   - ✅ "When the user submits the registration form"
4. **Every functional requirement SHOULD have at least one scenario**
5. **Scenarios verify correctness** — if a requirement can't be expressed as a scenario, it's too vague

## Integration with SpecProductDesign
When generating requirement documents via `specproductdesign`:
- Each FR (functional requirement) in `functions-XX.md` should be followed by one or more scenarios
- Scenarios make requirements testable and unambiguous
