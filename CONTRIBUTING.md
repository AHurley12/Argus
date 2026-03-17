# Contributing to Argus

Thank you for considering contributing to Argus! Here are some guidelines to help streamline the process and ensure the quality of the codebase.

## Code Style
- We use **vanilla JavaScript** to keep our codebase lightweight and maintainable.
- The project follows a **modular structure**, so please organize your code into distinct modules.

## Testing Requirements
- All contributions must include tests. Make sure to test your code thoroughly and ensure all existing tests pass before submitting a pull request.

## Commit Message Conventions
Follow these conventions for commit messages:
- `feat:`    A new feature
- `fix:`     A bug fix
- `chore:`   Changes to the build process or auxiliary tools and libraries
- `docs:`    Documentation only changes  

### Examples:
- `feat: add user authentication module`
- `fix: resolve issue with API endpoint`
- `chore: update dependencies`

## Pull Request Process
1. Fork the repository and create your branch from `main`.
2. Make your changes.<br/>
3. Ensure your code adheres to our coding style and passes all tests.
4. Submit a pull request (PR) describing your changes and why they should be merged.
5. Include a link to any relevant issues and ensure to follow any templates we provide for PRs.
   
## Adding New API Integrations or Risk Scoring Rules
- When adding new API integrations, please document the process clearly.
- Risk scoring rules should be added with appropriate tests and documentation.
- Make sure to follow existing patterns in the codebase and consider backward compatibility.

For more details on architecture decisions, refer to [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).  

Thank you for your contribution! We appreciate your help in making Argus better.