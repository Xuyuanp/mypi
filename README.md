# mypi

Personal pi package containing custom extensions, themes, and prompts.

> **Disclaimer**: Most of the content in this package is shamelessly stolen from
> other people's work and stitched together to fit my own workflow. If something
> looks familiar, it probably is. Use at your own risk -- it is tailored to my
> personal preferences and almost certainly won't suit yours out of the box.

## Structure

- `extensions/` - Custom pi extensions
- `themes/` - Custom themes for pi TUI
- `prompts/` - Prompt templates
- `skills/` - Specialized skills (future use)

## Installation

### Local Development

```bash
# from current directory
pi install .
```

## Development

This package follows the [pi package conventions](https://shittycodingagent.ai/docs/packages).

### Adding Resources

- **Extensions**: Add `.ts` or `.js` files to `extensions/`
- **Themes**: Add `.json` files to `themes/`
- **Prompts**: Add `.md` files to `prompts/`
- **Skills**: Add `SKILL.md` files to `skills/` subdirectories

## License

MIT
