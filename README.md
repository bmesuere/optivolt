# OptiVolt 🔋

**OptiVolt** is a solver that finds the most efficient energy plan for your home.

It uses linear programming to decide — every 15 minutes — how your battery, EV, heat pump, and the grid should interact.
Feed it your load, solar forecast, and tariffs, and it returns a day-long schedule that minimizes cost and peaks.

### Planned features
- Fast linear and mixed-integer optimization using [HiGHS](https://github.com/ERGO-Code/HiGHS)
- Models power balance, battery dynamics, peak tariffs, and efficiency losses
- Works in Node or browser (WASM)
- Designed for integration with Home Assistant or custom dashboards
- Transparent LP format output — no black boxes, just math you can read

### Roadmap
- [x] Basic battery model
- [x] Time-of-use tariffs
- [x] Solar PV support
- [x] Battery cost
- [ ] Terminal state of charge
- [ ] html frontend
- [ ] Fetch predictions from Victron
- [ ] Convert plan to Victron commands
- [ ] EV charging model
- [ ] Heat pump model
