# Doctor Extension Naming

The internal Doctor extension mechanism uses Doctor Extension naming, not Doctor Plugin naming. The public internal API is `DoctorExtension` and `defineDoctorExtension`, while host-native terms such as Vite plugin, Nuxt module, and Nuxt app plugin remain unchanged where they refer to host concepts.
