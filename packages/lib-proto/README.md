
# @loom/proto

Definitions and utility functions for the protocol used by Loom's I/O.

## Introduction

The I/O protocol is based around the following concepts:

- **block**: a unit of data that is sent or received between the harness and
  a process.
- **envelope**: a wrapper around a sequence of blocks that includes metadata
  such as provenance.
- **manager**: a component that manages the lifecycle of processes, including
