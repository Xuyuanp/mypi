# mypi

Personal pi package containing custom extensions, themes, and prompts.

## Structure

- `extensions/` - Custom pi extensions
- `themes/` - Custom themes for pi TUI
- `prompts/` - Prompt templates
- `skills/` - Specialized skills (future use)

## Installation

### Local Development

```bash
# Install from local directory
pi install /Users/pangxuyuan/workspace/mywork/ai/mypi

# Or from current directory
pi install .
```

### Git Installation

```bash
# Install from git repository (once pushed)
pi install git:github.com/pangxuyuan/mypi
```

## Usage

Once installed, all extensions, themes, and prompts will be automatically available in pi.

## Development

This package follows the [pi package conventions](https://shittycodingagent.ai/docs/packages).

### Adding Resources

- **Extensions**: Add `.ts` or `.js` files to `extensions/`
- **Themes**: Add `.json` files to `themes/`
- **Prompts**: Add `.md` files to `prompts/`
- **Skills**: Add `SKILL.md` files to `skills/` subdirectories

## License

MIT
