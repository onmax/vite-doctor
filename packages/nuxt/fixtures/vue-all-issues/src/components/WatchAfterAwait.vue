<script lang="ts">
import { watch } from "vue";

export default {
  async setup() {
    await Promise.resolve();
    watch(
      () => true,
      () => {},
    );
  },
};
</script>
