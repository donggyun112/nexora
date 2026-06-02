# @nexora/fleet

Worker fleet registry, selection, and invocation helpers.

This package is the first concrete layer for running Nexora as a coordination
cluster: external agents register as workers, Nexora selects a worker by
capability, and the selected worker is invoked through a protocol adapter such
as HTTP.
