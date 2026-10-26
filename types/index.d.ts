declare module 'claude-code' {
  interface PluginState {
    'cc-crisply': {
      // Per message: the button a copy last took there (`3`, or `3:csv` for a
      // table's CSV button), to mark it `copied`.
      copied: StateFamily<string | null>
      // Per Mermaid diagram (its source, theme and form, and box art's width):
      // its merman pictures (as written, and turned where it turns) and their
      // sizes in pixels, or its box art, once drawn, or why there is neither;
      // null till then.
      figures: StateFamily<
        { pictures: { png: string; width: number; height: number }[] } | { text: string } | { failed: string } | null
      >
    }
  }
}
