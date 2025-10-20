Minimize
 obj: + 0.0075 grid_to_load_0 + 0.0075 grid_to_battery_0 - 0.00125 pv_to_grid_0 - 0.00125 battery_to_grid_0 + 0.000001 pv_to_grid_0 + 0.007 grid_to_load_1 + 0.007 grid_to_battery_1 - 0.00125 pv_to_grid_1 - 0.00125 battery_to_grid_1 + 0.000001 pv_to_grid_1 + 0.01375 grid_to_load_2 + 0.01375 grid_to_battery_2 - 0.01125 pv_to_grid_2 - 0.01125 battery_to_grid_2 + 0.000001 pv_to_grid_2 + 0.0055 grid_to_load_3 + 0.0055 grid_to_battery_3 - 0.00175 pv_to_grid_3 - 0.00175 battery_to_grid_3 + 0.000001 pv_to_grid_3 + 0.005 grid_to_load_4 + 0.005 grid_to_battery_4 - 0.002 pv_to_grid_4 - 0.002 battery_to_grid_4 + 0.000001 pv_to_grid_4 + 0.0045 grid_to_load_5 + 0.0045 grid_to_battery_5 - 0.00225 pv_to_grid_5 - 0.00225 battery_to_grid_5 + 0.000001 pv_to_grid_5 + 0.005 grid_to_load_6 + 0.005 grid_to_battery_6 - 0.00175 pv_to_grid_6 - 0.00175 battery_to_grid_6 + 0.000001 pv_to_grid_6 + 0.006 grid_to_load_7 + 0.006 grid_to_battery_7 - 0.0015 pv_to_grid_7 - 0.0015 battery_to_grid_7 + 0.000001 pv_to_grid_7

Subject To
 c_load_0: grid_to_load_0 + pv_to_load_0 + battery_to_load_0 = 1800
 c_load_1: grid_to_load_1 + pv_to_load_1 + battery_to_load_1 = 1500
 c_load_2: grid_to_load_2 + pv_to_load_2 + battery_to_load_2 = 1200
 c_load_3: grid_to_load_3 + pv_to_load_3 + battery_to_load_3 = 2000
 c_load_4: grid_to_load_4 + pv_to_load_4 + battery_to_load_4 = 2500
 c_load_5: grid_to_load_5 + pv_to_load_5 + battery_to_load_5 = 2200
 c_load_6: grid_to_load_6 + pv_to_load_6 + battery_to_load_6 = 1600
 c_load_7: grid_to_load_7 + pv_to_load_7 + battery_to_load_7 = 1400
 c_pv_split_0: pv_to_load_0 + pv_to_battery_0 + pv_to_grid_0 = 0
 c_pv_split_1: pv_to_load_1 + pv_to_battery_1 + pv_to_grid_1 = 0
 c_pv_split_2: pv_to_load_2 + pv_to_battery_2 + pv_to_grid_2 = 0
 c_pv_split_3: pv_to_load_3 + pv_to_battery_3 + pv_to_grid_3 = 100
 c_pv_split_4: pv_to_load_4 + pv_to_battery_4 + pv_to_grid_4 = 200
 c_pv_split_5: pv_to_load_5 + pv_to_battery_5 + pv_to_grid_5 = 600
 c_pv_split_6: pv_to_load_6 + pv_to_battery_6 + pv_to_grid_6 = 200
 c_pv_split_7: pv_to_load_7 + pv_to_battery_7 + pv_to_grid_7 = 100
 c_soc_0: soc_0 - 0.2375 grid_to_battery_0 - 0.2375 pv_to_battery_0 + 0.263157894737 battery_to_load_0 + 0.263157894737 battery_to_grid_0 = 4096
 c_soc_1: soc_1 - soc_0 - 0.2375 grid_to_battery_1 - 0.2375 pv_to_battery_1 + 0.263157894737 battery_to_load_1 + 0.263157894737 battery_to_grid_1 = 0
 c_soc_2: soc_2 - soc_1 - 0.2375 grid_to_battery_2 - 0.2375 pv_to_battery_2 + 0.263157894737 battery_to_load_2 + 0.263157894737 battery_to_grid_2 = 0
 c_soc_3: soc_3 - soc_2 - 0.2375 grid_to_battery_3 - 0.2375 pv_to_battery_3 + 0.263157894737 battery_to_load_3 + 0.263157894737 battery_to_grid_3 = 0
 c_soc_4: soc_4 - soc_3 - 0.2375 grid_to_battery_4 - 0.2375 pv_to_battery_4 + 0.263157894737 battery_to_load_4 + 0.263157894737 battery_to_grid_4 = 0
 c_soc_5: soc_5 - soc_4 - 0.2375 grid_to_battery_5 - 0.2375 pv_to_battery_5 + 0.263157894737 battery_to_load_5 + 0.263157894737 battery_to_grid_5 = 0
 c_soc_6: soc_6 - soc_5 - 0.2375 grid_to_battery_6 - 0.2375 pv_to_battery_6 + 0.263157894737 battery_to_load_6 + 0.263157894737 battery_to_grid_6 = 0
 c_soc_7: soc_7 - soc_6 - 0.2375 grid_to_battery_7 - 0.2375 pv_to_battery_7 + 0.263157894737 battery_to_load_7 + 0.263157894737 battery_to_grid_7 = 0
 c_charge_cap_0: grid_to_battery_0 + pv_to_battery_0 <= 3600
 c_discharge_cap_0: battery_to_load_0 + battery_to_grid_0 <= 4000
 c_grid_import_cap_0: grid_to_load_0 + grid_to_battery_0 <= 2500
 c_grid_export_cap_0: pv_to_grid_0 + battery_to_grid_0 <= 5000
 c_charge_cap_1: grid_to_battery_1 + pv_to_battery_1 <= 3600
 c_discharge_cap_1: battery_to_load_1 + battery_to_grid_1 <= 4000
 c_grid_import_cap_1: grid_to_load_1 + grid_to_battery_1 <= 2500
 c_grid_export_cap_1: pv_to_grid_1 + battery_to_grid_1 <= 5000
 c_charge_cap_2: grid_to_battery_2 + pv_to_battery_2 <= 3600
 c_discharge_cap_2: battery_to_load_2 + battery_to_grid_2 <= 4000
 c_grid_import_cap_2: grid_to_load_2 + grid_to_battery_2 <= 2500
 c_grid_export_cap_2: pv_to_grid_2 + battery_to_grid_2 <= 5000
 c_charge_cap_3: grid_to_battery_3 + pv_to_battery_3 <= 3600
 c_discharge_cap_3: battery_to_load_3 + battery_to_grid_3 <= 4000
 c_grid_import_cap_3: grid_to_load_3 + grid_to_battery_3 <= 2500
 c_grid_export_cap_3: pv_to_grid_3 + battery_to_grid_3 <= 5000
 c_charge_cap_4: grid_to_battery_4 + pv_to_battery_4 <= 3600
 c_discharge_cap_4: battery_to_load_4 + battery_to_grid_4 <= 4000
 c_grid_import_cap_4: grid_to_load_4 + grid_to_battery_4 <= 2500
 c_grid_export_cap_4: pv_to_grid_4 + battery_to_grid_4 <= 5000
 c_charge_cap_5: grid_to_battery_5 + pv_to_battery_5 <= 3600
 c_discharge_cap_5: battery_to_load_5 + battery_to_grid_5 <= 4000
 c_grid_import_cap_5: grid_to_load_5 + grid_to_battery_5 <= 2500
 c_grid_export_cap_5: pv_to_grid_5 + battery_to_grid_5 <= 5000
 c_charge_cap_6: grid_to_battery_6 + pv_to_battery_6 <= 3600
 c_discharge_cap_6: battery_to_load_6 + battery_to_grid_6 <= 4000
 c_grid_import_cap_6: grid_to_load_6 + grid_to_battery_6 <= 2500
 c_grid_export_cap_6: pv_to_grid_6 + battery_to_grid_6 <= 5000
 c_charge_cap_7: grid_to_battery_7 + pv_to_battery_7 <= 3600
 c_discharge_cap_7: battery_to_load_7 + battery_to_grid_7 <= 4000
 c_grid_import_cap_7: grid_to_load_7 + grid_to_battery_7 <= 2500
 c_grid_export_cap_7: pv_to_grid_7 + battery_to_grid_7 <= 5000

Bounds
 0 <= grid_to_load_0 <= 1800
 0 <= grid_to_battery_0 <= 2500
 0 <= pv_to_load_0 <= 1800
 0 <= pv_to_battery_0 <= 0
 0 <= pv_to_grid_0 <= 0
 0 <= battery_to_load_0 <= 1800
 0 <= battery_to_grid_0 <= 4000
 4096 <= soc_0 <= 20480
 0 <= grid_to_load_1 <= 1500
 0 <= grid_to_battery_1 <= 2500
 0 <= pv_to_load_1 <= 1500
 0 <= pv_to_battery_1 <= 0
 0 <= pv_to_grid_1 <= 0
 0 <= battery_to_load_1 <= 1500
 0 <= battery_to_grid_1 <= 4000
 4096 <= soc_1 <= 20480
 0 <= grid_to_load_2 <= 1200
 0 <= grid_to_battery_2 <= 2500
 0 <= pv_to_load_2 <= 1200
 0 <= pv_to_battery_2 <= 0
 0 <= pv_to_grid_2 <= 0
 0 <= battery_to_load_2 <= 1200
 0 <= battery_to_grid_2 <= 4000
 4096 <= soc_2 <= 20480
 0 <= grid_to_load_3 <= 2000
 0 <= grid_to_battery_3 <= 2500
 0 <= pv_to_load_3 <= 2000
 0 <= pv_to_battery_3 <= 100
 0 <= pv_to_grid_3 <= 100
 0 <= battery_to_load_3 <= 2000
 0 <= battery_to_grid_3 <= 4000
 4096 <= soc_3 <= 20480
 0 <= grid_to_load_4 <= 2500
 0 <= grid_to_battery_4 <= 2500
 0 <= pv_to_load_4 <= 2500
 0 <= pv_to_battery_4 <= 200
 0 <= pv_to_grid_4 <= 200
 0 <= battery_to_load_4 <= 2500
 0 <= battery_to_grid_4 <= 4000
 4096 <= soc_4 <= 20480
 0 <= grid_to_load_5 <= 2200
 0 <= grid_to_battery_5 <= 2500
 0 <= pv_to_load_5 <= 2200
 0 <= pv_to_battery_5 <= 600
 0 <= pv_to_grid_5 <= 600
 0 <= battery_to_load_5 <= 2200
 0 <= battery_to_grid_5 <= 4000
 4096 <= soc_5 <= 20480
 0 <= grid_to_load_6 <= 1600
 0 <= grid_to_battery_6 <= 2500
 0 <= pv_to_load_6 <= 1600
 0 <= pv_to_battery_6 <= 200
 0 <= pv_to_grid_6 <= 200
 0 <= battery_to_load_6 <= 1600
 0 <= battery_to_grid_6 <= 4000
 4096 <= soc_6 <= 20480
 0 <= grid_to_load_7 <= 1400
 0 <= grid_to_battery_7 <= 2500
 0 <= pv_to_load_7 <= 1400
 0 <= pv_to_battery_7 <= 100
 0 <= pv_to_grid_7 <= 100
 0 <= battery_to_load_7 <= 1400
 0 <= battery_to_grid_7 <= 4000
 4096 <= soc_7 <= 20480

End
