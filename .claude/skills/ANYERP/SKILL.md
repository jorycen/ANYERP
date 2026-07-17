```markdown
# ANYERP Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns used in the ANYERP JavaScript codebase. It covers file naming conventions, import/export styles, commit message formatting, and testing patterns. By following these guidelines, contributors can maintain consistency and quality throughout the project.

## Coding Conventions

### File Naming
- Use **camelCase** for all file names.
  - Example: `userProfile.js`, `orderManager.js`

### Imports
- Use **relative imports** for modules.
  - Example:
    ```javascript
    import userService from './userService';
    ```

### Exports
- Use **default exports** for modules.
  - Example:
    ```javascript
    const userService = { /* ... */ };
    export default userService;
    ```

### Commit Messages
- Follow **conventional commit** format.
- Use the `feat` prefix for new features.
  - Example:  
    ```
    feat: add user authentication middleware
    ```
- Average commit message length: ~54 characters.

## Workflows

### Feature Development
**Trigger:** When adding a new feature to the codebase  
**Command:** `/feature-development`

1. Create a new branch for your feature.
2. Implement the feature using camelCase file naming and relative imports.
3. Write or update tests in a corresponding `.test.js` file.
4. Commit changes using the `feat` prefix and a concise description.
5. Open a pull request for review.

### Testing
**Trigger:** Before merging or deploying code  
**Command:** `/run-tests`

1. Ensure all `.test.js` files are up to date.
2. Run the test suite using your preferred JavaScript test runner.
3. Confirm all tests pass before proceeding.

## Testing Patterns

- Test files are named with the `.test.js` suffix.
  - Example: `userService.test.js`
- The specific testing framework is not defined; use standard JavaScript test runners (e.g., Jest, Mocha) as appropriate.
- Place test files alongside the modules they test or in a dedicated `tests` directory.

**Example:**
```javascript
// userService.test.js
import userService from './userService';

test('should create a new user', () => {
  const user = userService.createUser('Alice');
  expect(user.name).toBe('Alice');
});
```

## Commands
| Command              | Purpose                                      |
|----------------------|----------------------------------------------|
| /feature-development | Start a new feature development workflow     |
| /run-tests           | Run all test suites before merging or release|
```
