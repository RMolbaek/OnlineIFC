# Contributing to Vispecta

Thank you for wanting to help! Vispecta is an IFC viewer for infrastructure projects that runs entirely in the browser. It is in beta, so bug reports are just as valuable as code.

## Report a bug

Open an [issue](https://github.com/vispecta-app/vispecta/issues/new/choose) (choose *Bug report*) with:

- what you did, what you expected and what happened;
- the browser and operating system;
- the version from the *About* dialog (ⓘ in the top right corner);
- if you can, a small IFC file that shows the problem. Only share files you are allowed to share – a cut-down or anonymised model is fine.

## Suggest a feature

Open an issue (choose *Idea or feature request*) and describe the task from your work: which models, what you need to see or check, and how you do it today. Ideas from real infrastructure projects (rail, road, bridges, utilities) are especially welcome.

## Contribute code

1. Fork the repository and create a branch from `main`.
2. Install and run: `npm install`, then `npm run dev` (Node 22).
3. Keep changes focused: one feature or fix per pull request.
4. Check that `npm run build` passes and try your change in the browser with a few models.
5. Open a pull request that says what changed and how you tested it. Screenshots help for UI changes.

### Guidelines

- **Local first:** IFC files must never leave the user's computer. Do not add uploads, analytics or tracking.
- **Languages:** the interface is in English, Danish, German and Hindi (`src/i18n.js`). Add new texts in English at least; other languages are welcome.
- **Style:** plain JavaScript modules, no framework. Follow the style of the surrounding code and comment the why, not the what.
- **Dependencies:** add new ones only when they clearly pay off, and pin exact versions.

## Licence

Vispecta is licensed under the [GNU AGPL-3.0](LICENSE). By contributing, you agree that your contributions are licensed under the same licence.
