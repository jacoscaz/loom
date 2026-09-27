
# Loom: configuration

See the reference [example configuration file].

## Validation

The loader casts the parsed config against the `Config` type (runtyped) and
then diffs the result against the raw parse; any key silently stripped by
validation is a boot error naming the exact path.

Unknown keys are rejected everywhere except the open regions of the type —
e.g. a model's `options.extras` block, where adapter-specific payloads ride
by design.

## Style discipline

Style discipline for session-model entries: dotted keys only. Never use
sub-table headers like `[models.session.options]` — in TOML they attach to
the LAST defined `[[models.session]]` element and misread badly in lists.

[example configuration file]: ../config-example.toml
